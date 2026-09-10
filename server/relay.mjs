#!/usr/bin/env node
/**
 * Ghostline relay.
 *
 * A dumb message switchboard so phones never have to reach each other
 * directly. WebRTC needs a route between two devices, and on mobile carriers
 * there often isn't one; both ends can always reach a server, so they talk
 * through this instead.
 *
 * It understands nothing about the game. One device per room is the host and
 * owns the world exactly as before — this only carries bytes between them, so
 * the authority model and the fog of war are untouched.
 *
 * Zero dependencies: the box has node but no npm, and a service that runs for
 * years unattended is better off with nothing to update. The WebSocket
 * framing below is therefore hand-rolled (RFC 6455).
 *
 *   node relay.mjs --port 8787 --host 127.0.0.1
 */

import http from 'node:http';
import crypto from 'node:crypto';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
};

const PORT = Number(arg('port', process.env.PORT || 8787));
const HOST = arg('host', process.env.HOST || '127.0.0.1');
const PATH_PREFIX = arg('path', process.env.WS_PATH || '/ws');

// --- limits. A public relay is a public resource; none of these are optional.
const MAX_ROOMS = 200;
const MAX_GUESTS = 16;
const MAX_MESSAGE = 128 * 1024;
const MAX_PER_IP = 24;
const MSG_PER_SEC = 80;              // per socket, averaged over a second
const IDLE_MS = 90_000;              // no traffic and no pong for this long
const PING_MS = 25_000;
const ROOM_TTL_MS = 6 * 60 * 60 * 1000;

const rooms = new Map();             // code -> {code, host, guests:Map, createdAt}
const perIp = new Map();             // ip -> count
let sockets = 0;

const now = () => Date.now();
const log = (...a) => console.log(new Date().toISOString(), ...a);

// ---------------------------------------------------------------------------
// WebSocket framing
// ---------------------------------------------------------------------------

/** Frame a text payload for sending. Server-to-client frames are never masked. */
function frame(payload, opcode = 0x1) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf8');
  const len = body.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x80 | opcode;         // FIN + opcode
  return Buffer.concat([header, body]);
}

/**
 * Incremental frame reader.
 *
 * Browsers may split a message across continuation frames and will always mask
 * their payloads, so neither case is optional.
 */
function createReader({ onMessage, onClose, onPong, onError }) {
  let buffer = Buffer.alloc(0);
  let fragments = [];
  let fragmentOp = null;
  let fragmentLen = 0;

  return function push(chunk) {
    buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;

    for (;;) {
      if (buffer.length < 2) return;
      const first = buffer[0];
      const second = buffer[1];
      const fin = (first & 0x80) !== 0;
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      let len = second & 0x7f;
      let offset = 2;

      if (len === 126) {
        if (buffer.length < offset + 2) return;
        len = buffer.readUInt16BE(offset);
        offset += 2;
      } else if (len === 127) {
        if (buffer.length < offset + 8) return;
        const big = buffer.readBigUInt64BE(offset);
        if (big > BigInt(MAX_MESSAGE)) return onError('frame-too-big');
        len = Number(big);
        offset += 8;
      }
      if (len > MAX_MESSAGE) return onError('frame-too-big');

      let mask = null;
      if (masked) {
        if (buffer.length < offset + 4) return;
        mask = buffer.subarray(offset, offset + 4);
        offset += 4;
      }
      if (buffer.length < offset + len) return;    // wait for the rest

      const payload = Buffer.from(buffer.subarray(offset, offset + len));
      if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      buffer = buffer.subarray(offset + len);

      // Control frames may arrive in the middle of a fragmented message.
      if (opcode === 0x8) return onClose();
      if (opcode === 0x9) { onPong(payload, true); continue; }
      if (opcode === 0xA) { onPong(payload, false); continue; }

      if (opcode === 0x0) {
        if (fragmentOp === null) return onError('unexpected-continuation');
        fragmentLen += payload.length;
        if (fragmentLen > MAX_MESSAGE) return onError('message-too-big');
        fragments.push(payload);
        if (fin) {
          const full = Buffer.concat(fragments);
          fragments = []; fragmentOp = null; fragmentLen = 0;
          onMessage(full);
        }
        continue;
      }

      if (!fin) {
        fragmentOp = opcode;
        fragments = [payload];
        fragmentLen = payload.length;
        continue;
      }
      onMessage(payload);
    }
  };
}

// ---------------------------------------------------------------------------
// Rooms
// ---------------------------------------------------------------------------

const send = (sock, obj) => {
  if (!sock || sock.destroyed) return false;
  try { sock.write(frame(JSON.stringify(obj))); return true; } catch { return false; }
};

function closeSocket(sock, reason) {
  try {
    sock.write(frame(Buffer.from([0x03, 0xe8]), 0x8));   // 1000, normal
  } catch { /* already gone */ }
  try { sock.destroy(); } catch { /* already gone */ }
  if (reason) log('close', sock.meta?.id || '-', reason);
}

function dropRoom(room) {
  rooms.delete(room.code);
  log('room closed', room.code);
}

function leave(sock) {
  const meta = sock.meta;
  if (!meta) return;
  const ip = meta.ip;
  const n = (perIp.get(ip) || 1) - 1;
  if (n <= 0) perIp.delete(ip); else perIp.set(ip, n);

  const room = rooms.get(meta.room);
  if (!room) return;
  if (meta.role === 'host' && room.host === sock) {
    room.host = null;
    // Tell the guests the host has gone so they can show something useful
    // rather than sitting on a frozen map.
    for (const g of room.guests.values()) send(g, { t: 'host-gone' });
    if (!room.guests.size) dropRoom(room);
  } else if (room.guests.get(meta.id) === sock) {
    room.guests.delete(meta.id);
    send(room.host, { t: 'peer-left', id: meta.id });
    if (!room.host && !room.guests.size) dropRoom(room);
  }
}

function admit(sock, { room: code, role, id }) {
  let room = rooms.get(code);
  if (!room) {
    if (rooms.size >= MAX_ROOMS) return { error: 'relay-full' };
    room = { code, host: null, guests: new Map(), createdAt: now() };
    rooms.set(code, room);
    log('room opened', code);
  }

  if (role === 'host') {
    // A host reclaiming its own room after a reload replaces the old socket.
    if (room.host && room.host !== sock && !room.host.destroyed) {
      if (room.hostId !== id) return { error: 'room-taken' };
      closeSocket(room.host, 'host replaced');
    }
    room.host = sock;
    room.hostId = id;
    sock.meta = { room: code, role: 'host', id, ip: sock.meta.ip };
    send(sock, { t: 'joined', room: code, role: 'host' });
    // Re-announce anyone already waiting, so a host that reloaded catches up.
    for (const gid of room.guests.keys()) send(sock, { t: 'peer-join', id: gid });
    return { ok: true };
  }

  if (room.guests.size >= MAX_GUESTS && !room.guests.has(id)) return { error: 'room-full' };
  const existing = room.guests.get(id);
  if (existing && existing !== sock) closeSocket(existing, 'replaced by same id');
  room.guests.set(id, sock);
  sock.meta = { room: code, role: 'guest', id, ip: sock.meta.ip };
  send(sock, { t: 'joined', room: code, role: 'guest', hostPresent: !!room.host });
  send(room.host, { t: 'peer-join', id });
  return { ok: true };
}

/** Move one message between a guest and the host. Nothing is inspected. */
function route(sock, text) {
  const meta = sock.meta;
  const room = rooms.get(meta.room);
  if (!room) return;

  if (meta.role === 'guest') {
    if (!room.host) { send(sock, { t: 'no-host' }); return; }
    send(room.host, { t: 'msg', from: meta.id, d: text });
    return;
  }

  // From the host: addressed to one guest, or to all of them.
  let envelope;
  try { envelope = JSON.parse(text); } catch { return; }
  if (!envelope || envelope.t !== 'msg') return;
  const payload = { t: 'msg', d: envelope.d };
  if (envelope.to === '*') {
    for (const g of room.guests.values()) send(g, payload);
  } else {
    send(room.guests.get(envelope.to), payload);
  }
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const server = http.createServer((req, res) => {
  if (req.url === '/health' || req.url === `${PATH_PREFIX}/health`) {
    const body = JSON.stringify({
      ok: true,
      rooms: rooms.size,
      sockets,
      uptimeS: Math.round(process.uptime()),
    });
    res.writeHead(200, {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      // The game is served from a different origin to this relay, and the
      // connection screen reads this to tell a player whether the relay is up.
      'access-control-allow-origin': '*',
    });
    res.end(body);
    return;
  }
  res.writeHead(426, { 'content-type': 'text/plain' });
  res.end('This endpoint speaks WebSocket.\n');
});

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://relay.invalid');
  const key = req.headers['sec-websocket-key'];
  const bad = (code, msg) => {
    socket.write(`HTTP/1.1 ${code} ${msg}\r\nConnection: close\r\n\r\n`);
    socket.destroy();
  };
  if (!key || req.headers.upgrade?.toLowerCase() !== 'websocket') return bad(400, 'Bad Request');

  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || socket.remoteAddress || '?';
  const count = perIp.get(ip) || 0;
  if (count >= MAX_PER_IP) return bad(429, 'Too Many Requests');

  // Bound the input before touching it, then validate — never truncate into
  // validity, or two people who typed different codes quietly share a room.
  const code = (url.searchParams.get('room') || '').slice(0, 32).toUpperCase();
  const role = url.searchParams.get('role') === 'host' ? 'host' : 'guest';
  const id = (url.searchParams.get('id') || '').slice(0, 128);
  // Room codes are ours (four characters); peer ids come from the client and
  // only need to be non-empty and safe to use as a map key.
  if (!/^[A-Z0-9]{3,8}$/.test(code) || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) return bad(400, 'Bad Request');

  const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n'
    + 'Upgrade: websocket\r\n'
    + 'Connection: Upgrade\r\n'
    + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );

  socket.setNoDelay(true);
  socket.meta = { ip };
  sockets += 1;
  perIp.set(ip, count + 1);

  const result = admit(socket, { room: code, role, id });
  if (result.error) {
    send(socket, { t: 'error', e: result.error });
    sockets -= 1;
    perIp.set(ip, count);
    closeSocket(socket, result.error);
    return;
  }

  let budget = MSG_PER_SEC;
  let lastSeen = now();
  const refill = setInterval(() => { budget = MSG_PER_SEC; }, 1000);

  const read = createReader({
    onMessage(payload) {
      lastSeen = now();
      if (budget-- <= 0) return;                    // over the rate limit: drop
      if (payload.length > MAX_MESSAGE) return;
      route(socket, payload.toString('utf8'));
    },
    onPong() { lastSeen = now(); },
    onClose() { socket.destroy(); },
    onError(reason) { closeSocket(socket, reason); },
  });

  socket.on('data', (chunk) => {
    try { read(chunk); } catch (err) { closeSocket(socket, `read: ${err.message}`); }
  });

  const keepalive = setInterval(() => {
    if (now() - lastSeen > IDLE_MS) { closeSocket(socket, 'idle'); return; }
    try { socket.write(frame(Buffer.alloc(0), 0x9)); } catch { /* going away */ }
  }, PING_MS);

  const cleanup = () => {
    clearInterval(refill);
    clearInterval(keepalive);
    sockets = Math.max(0, sockets - 1);
    leave(socket);
  };
  socket.on('close', cleanup);
  socket.on('error', cleanup);
  if (head && head.length) socket.emit('data', head);
});

// Rooms nobody came back to.
setInterval(() => {
  for (const room of [...rooms.values()]) {
    if (!room.host && !room.guests.size) dropRoom(room);
    else if (now() - room.createdAt > ROOM_TTL_MS && !room.host) dropRoom(room);
  }
}, 60_000).unref?.();

server.listen(PORT, HOST, () => {
  log(`ghostline relay listening on ${HOST}:${PORT} (ws path ${PATH_PREFIX})`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    log('shutting down');
    for (const room of rooms.values()) {
      if (room.host) closeSocket(room.host, 'shutdown');
      for (const g of room.guests.values()) closeSocket(g, 'shutdown');
    }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}

export { server, rooms };
