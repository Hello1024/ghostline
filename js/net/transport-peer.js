/**
 * WebRTC transport over PeerJS.
 *
 * The game is served as static files with no backend, so the only server in
 * the picture is PeerJS's free signalling broker, used to introduce devices to
 * each other. Once introduced, game traffic goes phone-to-phone.
 *
 * Topology is a star: the host's device is the hub and the authority. Seven
 * players is well inside what one phone can carry.
 */

/* global Peer */

const HOST_PREFIX = 'ghostline-';
const OPEN_TIMEOUT_MS = 20000;

const peerOptions = () => ({ debug: 0, config: {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:global.stun.twilio.com:3478' },
  ],
} });

function waitForPeer(peer) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out reaching the matchmaking server')), OPEN_TIMEOUT_MS);
    peer.on('open', (id) => { clearTimeout(timer); resolve(id); });
    peer.on('error', (err) => { clearTimeout(timer); reject(err); });
  });
}

/**
 * Host side: claim the lobby code and accept connections.
 * @returns {Promise<object>} a transport with the shape host.js expects
 */
export async function createPeerHost(code, { onStatus } = {}) {
  const peer = new Peer(HOST_PREFIX + code, peerOptions());
  onStatus?.('Reserving the lobby code…');
  await waitForPeer(peer);
  const handlers = {};
  const conns = new Map();

  peer.on('connection', (conn) => {
    conns.set(conn.peer, conn);
    conn.on('open', () => handlers.onConnect?.(conn.peer));
    conn.on('data', (data) => handlers.onMessage?.(conn.peer, data));
    conn.on('close', () => { conns.delete(conn.peer); handlers.onDisconnect?.(conn.peer); });
    conn.on('error', () => { conns.delete(conn.peer); handlers.onDisconnect?.(conn.peer); });
  });
  peer.on('error', (err) => handlers.onError?.(err));

  return {
    isHost: true,
    peer,
    on(h) { Object.assign(handlers, h); },
    send(peerId, data) {
      const conn = conns.get(peerId);
      if (!conn || !conn.open) return false;
      try { conn.send(data); return true; } catch { return false; }
    },
    broadcast(data) { for (const id of [...conns.keys()]) this.send(id, data); },
    disconnect(peerId) { conns.get(peerId)?.close(); conns.delete(peerId); },
    close() { for (const c of conns.values()) c.close(); peer.destroy(); },
    get peerIds() { return [...conns.keys()]; },
  };
}

/**
 * Client side: find the host by lobby code and hold the connection open,
 * reconnecting on its own when a phone drops off the network mid-match.
 */
export async function createPeerClient(code, { onStatus, onLink } = {}) {
  const peer = new Peer(null, peerOptions());
  onStatus?.('Connecting…');
  await waitForPeer(peer);
  const handlers = {};
  let conn = null;
  let closed = false;
  let attempts = 0;

  function attach(c) {
    conn = c;
    c.on('open', () => {
      attempts = 0;
      onLink?.(true);
      handlers.onOpen?.();
    });
    c.on('data', (data) => handlers.onMessage?.(data));
    c.on('close', () => { onLink?.(false); handlers.onClose?.(); retry(); });
    c.on('error', () => { onLink?.(false); retry(); });
  }

  function dial() {
    return peer.connect(HOST_PREFIX + code, { reliable: true, serialization: 'json' });
  }

  function retry() {
    if (closed) return;
    attempts += 1;
    // Back off, but never so far that a player is stuck staring at a dead screen.
    const wait = Math.min(8000, 500 * 2 ** Math.min(attempts, 4));
    onStatus?.(`Reconnecting… (${attempts})`);
    setTimeout(() => { if (!closed) attach(dial()); }, wait);
  }

  attach(dial());

  return {
    isHost: false,
    peer,
    on(h) { Object.assign(handlers, h); },
    send(data) {
      if (!conn || !conn.open) return false;
      try { conn.send(data); return true; } catch { return false; }
    },
    close() { closed = true; conn?.close(); peer.destroy(); },
    get connected() { return !!conn && conn.open; },
  };
}

export { HOST_PREFIX };
