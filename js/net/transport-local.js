/**
 * An in-process transport: host and clients talking through function calls.
 *
 * Practice mode runs on this (you against bots, no network at all), and the
 * networking tests use it to drive a deterministic multi-client session
 * without needing a signalling server.
 */

export function createLocalPair() {
  const hub = {
    hostHandlers: {},
    peers: new Map(),        // peerId -> client handlers
    queue: [],
    async: false,
    dropped: 0,
  };

  const deliver = (fn) => {
    if (hub.async) hub.queue.push(fn);
    else fn();
  };

  const host = {
    isHost: true,
    on(handlers) { Object.assign(hub.hostHandlers, handlers); },
    send(peerId, data) {
      const peer = hub.peers.get(peerId);
      if (!peer) { hub.dropped++; return false; }
      deliver(() => peer.onMessage?.(data));
      return true;
    },
    broadcast(data) {
      for (const id of [...hub.peers.keys()]) host.send(id, data);
    },
    disconnect(peerId) {
      if (!hub.peers.has(peerId)) return;
      hub.peers.delete(peerId);
      deliver(() => hub.hostHandlers.onDisconnect?.(peerId));
    },
    close() { hub.peers.clear(); },
    get peerIds() { return [...hub.peers.keys()]; },
  };

  /** Attach a client; returns its transport handle. */
  function connect(peerId) {
    const handlers = {};
    hub.peers.set(peerId, handlers);
    deliver(() => hub.hostHandlers.onConnect?.(peerId));
    return {
      isHost: false,
      peerId,
      on(h) { Object.assign(handlers, h); },
      send(data) {
        if (!hub.peers.has(peerId)) { hub.dropped++; return false; }
        deliver(() => hub.hostHandlers.onMessage?.(peerId, data));
        return true;
      },
      close() { host.disconnect(peerId); },
    };
  }

  /** Run queued deliveries (only meaningful when `async` is on). */
  function flush(rounds = 8) {
    for (let i = 0; i < rounds && hub.queue.length; i++) {
      const batch = hub.queue.splice(0, hub.queue.length);
      for (const fn of batch) fn();
    }
  }

  return { host, connect, flush, hub };
}
