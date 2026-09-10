/**
 * WebRTC transport over PeerJS.
 *
 * The game is served as static files with no backend, so the only server in
 * the picture is PeerJS's free signalling broker, used to introduce devices to
 * each other. Once introduced, game traffic goes phone-to-phone.
 *
 * Topology is a star: the host's device is the hub and the authority. Seven
 * players is well inside what one phone can carry.
 *
 * ## Getting through NAT
 *
 * Two phones on the same wifi find each other directly. Across networks — one
 * on mobile data, one at home — they need help:
 *
 *   STUN tells a device its own public address. Enough for most home routers.
 *   TURN relays the traffic when the NAT will not allow a direct path at all,
 *        which is common on mobile carriers using symmetric NAT.
 *
 * The STUN servers below are public and were each checked to return a
 * server-reflexive candidate. There is no free public TURN worth shipping any
 * more — the well-known open relays now refuse the credentials they document —
 * so TURN is optional and supplied by whoever is hosting. See README.
 *
 * A dead ICE server is worse than none: gathering blocks on it for twelve
 * seconds instead of finishing in under two hundred milliseconds. Nothing goes
 * in this list unless it answers.
 */

/* global Peer */

const HOST_PREFIX = 'ghostline-';
const OPEN_TIMEOUT_MS = 20000;

/** Public STUN, each verified to return a reflexive candidate. */
export const STUN_SERVERS = [
  { urls: [
    'stun:stun.l.google.com:19302',
    'stun:stun1.l.google.com:19302',
    'stun:stun2.l.google.com:19302',
  ] },
  { urls: 'stun:stun.cloudflare.com:3478' },
  // On port 443, which gets out through firewalls that block anything else.
  { urls: 'stun:stun.nextcloud.com:443' },
];

const TURN_KEY = 'ghostline.turn';

/**
 * Read the operator-supplied TURN server, if there is one.
 * Shape: {"urls":"turn:host:3478","username":"u","credential":"p"}
 */
export function savedTurn() {
  try {
    const raw = localStorage.getItem(TURN_KEY);
    if (!raw) return null;
    const t = JSON.parse(raw);
    if (!t || typeof t.urls !== 'string' || !t.urls.trim()) return null;
    return {
      urls: t.urls.trim(),
      username: String(t.username ?? ''),
      credential: String(t.credential ?? ''),
    };
  } catch {
    return null;
  }
}

export function saveTurn(turn) {
  try {
    if (!turn || !turn.urls) localStorage.removeItem(TURN_KEY);
    else localStorage.setItem(TURN_KEY, JSON.stringify(turn));
    return true;
  } catch {
    return false;
  }
}

export function iceServers() {
  const turn = savedTurn();
  return turn ? [...STUN_SERVERS, turn] : [...STUN_SERVERS];
}

const peerOptions = () => ({
  debug: 0,
  config: {
    iceServers: iceServers(),
    // Warm a few candidates before we need them; shaves a beat off connecting.
    iceCandidatePoolSize: 2,
  },
});

/** Describe how a peer connection is actually routed, for the diagnostics panel. */
export async function describeRoute(conn) {
  const pc = conn?.peerConnection;
  if (!pc) return { state: 'no connection' };
  const state = pc.iceConnectionState;
  try {
    const stats = await pc.getStats();
    let pair = null;
    const candidates = new Map();
    stats.forEach((r) => {
      if (r.type === 'local-candidate' || r.type === 'remote-candidate') candidates.set(r.id, r);
      if (r.type === 'candidate-pair' && r.state === 'succeeded' && (r.nominated ?? true)) pair = r;
    });
    if (!pair) return { state, route: 'not established' };
    const local = candidates.get(pair.localCandidateId);
    const remote = candidates.get(pair.remoteCandidateId);
    const kind = (c) => c?.candidateType || '?';
    const relayed = kind(local) === 'relay' || kind(remote) === 'relay';
    return {
      state,
      route: relayed ? 'relayed through TURN' : (kind(local) === 'host' ? 'direct, same network' : 'direct across networks'),
      local: kind(local),
      remote: kind(remote),
      rttMs: pair.currentRoundTripTime != null ? Math.round(pair.currentRoundTripTime * 1000) : null,
    };
  } catch {
    return { state, route: 'unknown' };
  }
}

function waitForPeer(peer) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Timed out reaching the matchmaking server')),
      OPEN_TIMEOUT_MS,
    );
    peer.once('open', (id) => { clearTimeout(timer); resolve(id); });
    peer.once('error', (err) => { clearTimeout(timer); reject(err); });
  });
}

/** Turn a PeerJS error into something worth showing a person. */
export function explainPeerError(err) {
  switch (err?.type) {
    case 'peer-unavailable': return 'No game with that code — check it, or ask the host to reopen the lobby.';
    case 'unavailable-id': return 'That lobby code is already taken. Start a new game to get another.';
    case 'browser-incompatible': return 'This browser cannot do peer-to-peer connections.';
    case 'network': return 'Lost the matchmaking server. Retrying…';
    case 'server-error': return 'The matchmaking server is not responding. Retrying…';
    case 'ssl-unavailable': return 'A secure connection to the matchmaking server failed.';
    case 'webrtc': return 'The connection could not be established.';
    default: return err?.message || 'Connection problem.';
  }
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

  // Errors after the peer is open used to vanish: a lost signalling socket
  // looked exactly like a quiet lobby.
  peer.on('error', (err) => {
    onStatus?.(explainPeerError(err));
    handlers.onError?.(err);
  });
  peer.on('disconnected', () => {
    onStatus?.('Signalling dropped — reconnecting…');
    if (!peer.destroyed) peer.reconnect();
  });

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
    route: (peerId) => describeRoute(conns.get(peerId)),
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
  let retryTimer = null;

  function attach(c) {
    conn = c;
    let settled = false;
    // A connection that never opens is the common cross-network failure:
    // both sides gathered candidates and none of them worked.
    const opening = setTimeout(() => {
      if (!settled && !closed) {
        onStatus?.('No direct route to the host yet — still trying…');
        try { c.close(); } catch { /* already gone */ }
        retry();
      }
    }, 25000);

    c.on('open', () => {
      settled = true;
      clearTimeout(opening);
      attempts = 0;
      onLink?.(true);
      handlers.onOpen?.();
    });
    c.on('data', (data) => handlers.onMessage?.(data));
    c.on('close', () => {
      clearTimeout(opening);
      onLink?.(false);
      handlers.onClose?.();
      retry();
    });
    c.on('error', () => { clearTimeout(opening); onLink?.(false); retry(); });
  }

  const dial = () => peer.connect(HOST_PREFIX + code, { reliable: true, serialization: 'json' });

  function retry() {
    if (closed || retryTimer) return;
    attempts += 1;
    // Back off, but never so far that a player is stuck staring at a dead screen.
    const wait = Math.min(8000, 500 * 2 ** Math.min(attempts, 4));
    onStatus?.(`Reconnecting… (${attempts})`);
    retryTimer = setTimeout(() => {
      retryTimer = null;
      if (!closed) attach(dial());
    }, wait);
  }

  // Peer-level errors arrive here, not on the connection. `peer-unavailable`
  // in particular means the host is not there — without this the client sat on
  // "Connecting…" forever and never tried again.
  peer.on('error', (err) => {
    onStatus?.(explainPeerError(err));
    handlers.onError?.(err);
    if (['peer-unavailable', 'network', 'server-error'].includes(err?.type)) retry();
  });
  peer.on('disconnected', () => {
    if (!closed && !peer.destroyed) peer.reconnect();
  });

  attach(dial());

  return {
    isHost: false,
    peer,
    on(h) { Object.assign(handlers, h); },
    send(data) {
      if (!conn || !conn.open) return false;
      try { conn.send(data); return true; } catch { return false; }
    },
    close() {
      closed = true;
      clearTimeout(retryTimer);
      conn?.close();
      peer.destroy();
    },
    get connected() { return !!conn && conn.open; },
    route: () => describeRoute(conn),
  };
}

export { HOST_PREFIX };
