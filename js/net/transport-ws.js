/**
 * Transport over a relay.
 *
 * Every device opens one WebSocket to a small server that does nothing but
 * pass messages between them. It replaced a peer-to-peer transport because
 * WebRTC needs a route between two phones and mobile carriers frequently do
 * not provide one; both ends can always reach a server.
 *
 * The relay understands nothing about the game. One device is still the host
 * and still owns the world, and every player is still sent only their own
 * fog-of-war view — this only carries the bytes, so nothing about the
 * authority model or the cheating story changes.
 *
 * The interface matches the old peer transport exactly, so host.js and
 * client.js did not have to know any of this happened.
 */

const DEFAULT_RELAY = 'wss://omattos.com/ghostline/ws';
const RELAY_KEY = 'ghostline.relay';
const RECONNECT_MAX_MS = 8000;

/** The relay this device will use. Overridable, so anyone can self-host. */
export function relayUrl() {
  try {
    const saved = localStorage.getItem(RELAY_KEY);
    if (saved && /^wss?:\/\//i.test(saved)) return saved;
  } catch { /* storage unavailable; fall through */ }
  return DEFAULT_RELAY;
}

export function saveRelayUrl(url) {
  try {
    if (!url) localStorage.removeItem(RELAY_KEY);
    else localStorage.setItem(RELAY_KEY, url);
    return true;
  } catch {
    return false;
  }
}

export const defaultRelay = () => DEFAULT_RELAY;

/**
 * Ask the relay how it is. Used by the connection screen.
 *
 * The health endpoint is a plain HTTP sibling of the socket path, because a
 * reverse proxy set up to tunnel WebSockets will not also serve ordinary GETs
 * on the same location.
 */
export function healthUrl(url = relayUrl()) {
  return url
    .replace(/^ws/i, 'http')
    .replace(/\/+$/, '')
    .replace(/\/ws$/i, '/health');
}

export async function relayHealth(url = relayUrl()) {
  const res = await fetch(healthUrl(url), { cache: 'no-store' });
  if (!res.ok) throw new Error(`relay returned ${res.status}`);
  return res.json();
}

/**
 * One socket, kept alive.
 *
 * A phone in a pocket suspends its connections, a train goes into a tunnel,
 * wifi hands over to mobile data. None of that should end a game, so this
 * reconnects on its own and tells the caller when it is back.
 */
function createSocket({ url, onOpen, onMessage, onClose, onStatus }) {
  let ws = null;
  let closed = false;
  let attempts = 0;
  let timer = null;

  function open() {
    if (closed) return;
    try {
      ws = new WebSocket(url);
    } catch (err) {
      onStatus?.(`Could not open a connection: ${err.message}`);
      schedule();
      return;
    }
    ws.addEventListener('open', () => {
      attempts = 0;
      onOpen?.();
    });
    ws.addEventListener('message', (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      onMessage?.(msg);
    });
    ws.addEventListener('close', () => {
      onClose?.();
      schedule();
    });
    ws.addEventListener('error', () => { /* close follows; handled there */ });
  }

  function schedule() {
    if (closed || timer) return;
    attempts += 1;
    const wait = Math.min(RECONNECT_MAX_MS, 400 * 2 ** Math.min(attempts, 4));
    onStatus?.(attempts > 1 ? `Reconnecting… (${attempts})` : 'Reconnecting…');
    timer = setTimeout(() => { timer = null; open(); }, wait);
  }

  open();

  return {
    send(text) {
      if (!ws || ws.readyState !== WebSocket.OPEN) return false;
      try { ws.send(text); return true; } catch { return false; }
    },
    close() {
      closed = true;
      clearTimeout(timer);
      try { ws?.close(); } catch { /* already gone */ }
    },
    get open() { return ws?.readyState === WebSocket.OPEN; },
    get url() { return url; },
  };
}

const query = (code, role, id) =>
  `${relayUrl()}?room=${encodeURIComponent(code)}&role=${role}&id=${encodeURIComponent(id)}`;

/**
 * Host side. Resolves once the relay has confirmed the room is ours, so a
 * clashing lobby code fails before anyone is invited to it.
 */
export function createRelayHost(code, { playerId, onStatus } = {}) {
  const peers = new Set();
  // The relay re-announces waiting guests the moment a host joins, which can
  // be before the caller has had a chance to register handlers. Hold anything
  // that arrives early and deliver it once they have.
  const { handlers, fire, wire } = deferredHandlers();

  return new Promise((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (!settled) { settled = true; sock.close(); reject(new Error('The relay did not answer.')); }
    }, 15000);

    const sock = createSocket({
      url: query(code, 'host', playerId),
      onStatus,
      onOpen: () => onStatus?.('Reserving the lobby code…'),
      onClose: () => { for (const id of peers) fire('onDisconnect', id); peers.clear(); },
      onMessage: (msg) => {
        switch (msg.t) {
          case 'joined':
            if (!settled) { settled = true; clearTimeout(timeout); resolve(transport); }
            onStatus?.('Lobby open');
            break;
          case 'peer-join':
            peers.add(msg.id);
            fire('onConnect', msg.id);
            break;
          case 'peer-left':
            peers.delete(msg.id);
            fire('onDisconnect', msg.id);
            break;
          case 'msg':
            fire('onMessage', msg.from, msg.d);
            break;
          case 'error':
            if (!settled) {
              settled = true;
              clearTimeout(timeout);
              sock.close();
              reject(new Error(explain(msg.e)));
            } else {
              onStatus?.(explain(msg.e));
            }
            break;
          default:
            break;
        }
      },
    });

    const transport = {
      isHost: true,
      on(h) { wire(h); },
      send(peerId, data) { return sock.send(JSON.stringify({ t: 'msg', to: peerId, d: data })); },
      broadcast(data) { return sock.send(JSON.stringify({ t: 'msg', to: '*', d: data })); },
      disconnect(peerId) { peers.delete(peerId); },
      close() { sock.close(); },
      get peerIds() { return [...peers]; },
      get connected() { return sock.open; },
      route: async () => ({ route: `relayed through ${new URL(sock.url).host}`, state: sock.open ? 'connected' : 'reconnecting' }),
    };
  });
}

/** Guest side. Resolves as soon as the relay has us in the room. */
export function createRelayClient(code, { playerId, onStatus, onLink } = {}) {
  const { handlers, fire, wire } = deferredHandlers();

  return new Promise((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (!settled) { settled = true; sock.close(); reject(new Error('The relay did not answer.')); }
    }, 15000);

    const sock = createSocket({
      url: query(code, 'guest', playerId),
      onStatus,
      onClose: () => { onLink?.(false); fire('onClose'); },
      onMessage: (msg) => {
        switch (msg.t) {
          case 'joined':
            if (!settled) { settled = true; clearTimeout(timeout); resolve(transport); }
            onLink?.(true);
            // Introduce ourselves to the host — on a reconnect too, which is
            // how a returning player reclaims their place in the match.
            fire('onOpen');
            onStatus?.(msg.hostPresent ? 'Connected' : 'Waiting for the host…');
            break;
          case 'msg':
            fire('onMessage', msg.d);
            break;
          case 'no-host':
            onStatus?.('The host is not connected yet.');
            break;
          case 'host-gone':
            onStatus?.('The host dropped out — waiting for them to come back.');
            fire('onHostGone');
            break;
          case 'error':
            if (!settled) {
              settled = true;
              clearTimeout(timeout);
              sock.close();
              reject(new Error(explain(msg.e)));
            } else {
              onStatus?.(explain(msg.e));
            }
            break;
          default:
            break;
        }
      },
    });

    const transport = {
      isHost: false,
      on(h) { wire(h); },
      send(data) { return sock.send(data); },
      close() { sock.close(); },
      get connected() { return sock.open; },
      route: async () => ({ route: `relayed through ${new URL(sock.url).host}`, state: sock.open ? 'connected' : 'reconnecting' }),
    };
  });
}

/**
 * Handlers that can be registered after events have already started arriving.
 * Anything fired before `wire()` is queued and replayed in order.
 */
function deferredHandlers() {
  const handlers = {};
  let ready = false;
  const pending = [];
  const fire = (name, ...args) => {
    if (!ready) { pending.push([name, args]); return; }
    handlers[name]?.(...args);
  };
  const wire = (h) => {
    Object.assign(handlers, h);
    if (ready) return;
    ready = true;
    const queued = pending.splice(0);
    for (const [name, args] of queued) handlers[name]?.(...args);
  };
  return { handlers, fire, wire };
}

function explain(code) {
  switch (code) {
    case 'room-taken': return 'Another device is already hosting that code. Start a new game.';
    case 'room-full': return 'That game is full.';
    case 'relay-full': return 'The relay is busy. Try again in a minute.';
    default: return `Connection problem (${code}).`;
  }
}
