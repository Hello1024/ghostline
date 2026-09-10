/**
 * Talk to a relay from the command line.
 *
 * A dependency-free WebSocket client, so it runs on any box with node and no
 * npm — including the relay's own host, which makes it useful for proving that
 * two genuinely different networks can reach each other through it.
 *
 *   node tools/relay-probe.mjs --room TEST --role host
 *   node tools/relay-probe.mjs --room TEST --role guest --say hello --seconds 8
 */
import net from 'node:net';
import tls from 'node:tls';
import crypto from 'node:crypto';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > -1 ? process.argv[i + 1] : d; };
const URL_ = arg('url', 'wss://omattos.com/ghostline/ws');
const room = arg('room', 'PROBE');
const role = arg('role', 'guest');
const id = arg('id', `probe-${Math.random().toString(36).slice(2, 8)}`);
const say = arg('say', null);
const seconds = Number(arg('seconds', 6));

const u = new URL(URL_);
const secure = u.protocol === 'wss:';
const port = u.port || (secure ? 443 : 80);
const path = `${u.pathname}?room=${encodeURIComponent(room)}&role=${role}&id=${encodeURIComponent(id)}`;
const key = crypto.randomBytes(16).toString('base64');

const connect = secure
  ? tls.connect({ host: u.hostname, port, servername: u.hostname })
  : net.connect({ host: u.hostname, port });

connect.on('secureConnect', start);
if (!secure) connect.on('connect', start);

function start() {
  connect.write(
    `GET ${path} HTTP/1.1\r\n`
    + `Host: ${u.hostname}\r\n`
    + 'Upgrade: websocket\r\nConnection: Upgrade\r\n'
    + `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
  );
}

/** Client frames must be masked, per the spec. */
function frame(text) {
  const body = Buffer.from(text, 'utf8');
  const mask = crypto.randomBytes(4);
  let header;
  if (body.length < 126) {
    header = Buffer.alloc(2);
    header[1] = 0x80 | body.length;
  } else if (body.length < 65536) {
    header = Buffer.alloc(4);
    header[1] = 0x80 | 126;
    header.writeUInt16BE(body.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(body.length), 2);
  }
  header[0] = 0x81;
  const masked = Buffer.from(body);
  for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i & 3];
  return Buffer.concat([header, mask, masked]);
}

let handshaken = false;
let buf = Buffer.alloc(0);

connect.on('data', (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  if (!handshaken) {
    const end = buf.indexOf('\r\n\r\n');
    if (end < 0) return;
    const head = buf.subarray(0, end).toString();
    if (!/101/.test(head)) {
      console.error('handshake refused:\n' + head.split('\r\n')[0]);
      process.exit(1);
    }
    handshaken = true;
    console.log(`connected to ${u.host} as ${role} "${id}" in room ${room}`);
    buf = buf.subarray(end + 4);
    if (say) setTimeout(() => connect.write(frame(say)), 300);
  }
  // Server frames are never masked, which keeps the reader simple.
  for (;;) {
    if (buf.length < 2) return;
    const opcode = buf[0] & 0x0f;
    let len = buf[1] & 0x7f;
    let off = 2;
    if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
    else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
    if (buf.length < off + len) return;
    const payload = buf.subarray(off, off + len).toString('utf8');
    buf = buf.subarray(off + len);
    if (opcode === 0x9) { connect.write(Buffer.concat([Buffer.from([0x8a, 0x80]), crypto.randomBytes(4)])); continue; }
    if (opcode === 0x8) { console.log('closed by relay'); process.exit(0); }
    if (opcode === 0x1) console.log('<-', payload.length > 200 ? `${payload.slice(0, 200)}… (${payload.length} bytes)` : payload);
  }
});

connect.on('error', (err) => { console.error('socket error:', err.message); process.exit(1); });
setTimeout(() => { console.log('done'); process.exit(0); }, seconds * 1000);
