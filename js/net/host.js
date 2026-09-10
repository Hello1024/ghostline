/**
 * The host session.
 *
 * One device owns the world. It applies everyone's intents, ticks the engine,
 * and sends each player their own fog-of-war view — never the whole state, so
 * a player who opens devtools learns nothing their screen wasn't showing.
 *
 * The host is usually also a player; its own intents skip the wire entirely.
 */

import { applyIntent, step } from '../engine/engine.js';
import { viewFor } from '../engine/view.js';
import { PHASE } from '../engine/constants.js';
import { MSG, PROTOCOL_VERSION, decode, encode } from './protocol.js';

const TICK_MS = 250;
const BROADCAST_MS = 500;

/**
 * @param {{transport:object, state:object, localPlayerId?:string,
 *          clock?:()=>number, onChange?:Function, onEvent?:Function}} opts
 */
export function createHost(opts) {
  const {
    transport, state, localPlayerId = null, localName = 'Host',
    clock = () => Date.now(),
  } = opts;
  const peerToPlayer = new Map();
  const playerToPeer = new Map();
  let lastBroadcast = 0;
  let timer = null;

  // The host usually plays too, so it takes a seat like anyone else — without
  // one it would not even be able to start its own match.
  if (localPlayerId) {
    state.hostId = localPlayerId;
    applyIntent(state, localPlayerId, { type: 'join', name: localName }, clock());
  }

  transport.on({
    onConnect(peerId) {
      opts.onEvent?.({ type: 'peer-connect', peerId });
    },
    onMessage(peerId, raw) {
      const parsed = decode(raw);
      if (!parsed.ok) {
        opts.onEvent?.({ type: 'bad-message', peerId, error: parsed.error });
        return;
      }
      handle(peerId, parsed.msg);
    },
    onDisconnect(peerId) {
      const playerId = peerToPlayer.get(peerId);
      peerToPlayer.delete(peerId);
      if (playerId && playerToPeer.get(playerId) === peerId) {
        playerToPeer.delete(playerId);
        const p = state.players[playerId];
        if (p) {
          // Leaving is not an escape: a disconnected player counts as dark,
          // so their team keeps paying for the absence and the other side
          // gets the beacon.
          p.connected = false;
        }
      }
      opts.onEvent?.({ type: 'peer-disconnect', peerId, playerId });
      opts.onChange?.();
    },
  });

  function handle(peerId, msg) {
    switch (msg.t) {
      case MSG.HELLO: {
        const playerId = msg.playerId;
        // Reconnecting with a known id reclaims the same player, mid-match.
        const existing = state.players[playerId];
        const r = applyIntent(state, playerId, { type: 'join', name: msg.name }, clock());
        if (!r.ok) {
          transport.send(peerId, encode({ t: MSG.ERROR, error: r.error }));
          return;
        }
        // One device per player: an older connection is retired.
        const stale = playerToPeer.get(playerId);
        if (stale && stale !== peerId) {
          peerToPlayer.delete(stale);
          transport.send(stale, encode({ t: MSG.BYE }));
        }
        peerToPlayer.set(peerId, playerId);
        playerToPeer.set(playerId, peerId);
        transport.send(peerId, encode({
          t: MSG.WELCOME, playerId, code: state.code, v: PROTOCOL_VERSION,
        }));
        opts.onEvent?.({ type: existing ? 'rejoin' : 'join', playerId, name: msg.name });
        sendView(playerId);
        opts.onChange?.();
        break;
      }
      case MSG.INTENT: {
        const playerId = peerToPlayer.get(peerId);
        if (!playerId) {
          transport.send(peerId, encode({ t: MSG.ERROR, error: 'say-hello-first' }));
          return;
        }
        const r = applyIntent(state, playerId, msg.i, clock());
        if (!r.ok && msg.i.type !== 'fix') {
          transport.send(peerId, encode({ t: MSG.ERROR, error: r.error }));
        }
        break;
      }
      case MSG.PING:
        transport.send(peerId, encode({ t: MSG.PONG, at: msg.at, hostNow: clock() }));
        break;
      case MSG.BYE:
        transport.disconnect?.(peerId);
        break;
      default:
        break;
    }
  }

  function sendView(playerId) {
    const peerId = playerToPeer.get(playerId);
    if (!peerId) return;
    const view = viewFor(state, playerId, state.t);
    if (view) transport.send(peerId, encode({ t: MSG.VIEW, view }));
  }

  function broadcastViews() {
    for (const playerId of playerToPeer.keys()) sendView(playerId);
  }

  /** Advance the world. Call it on a timer, or by hand from a test. */
  function tick(now = clock()) {
    step(state, now);
    if (now - lastBroadcast >= BROADCAST_MS) {
      lastBroadcast = now;
      broadcastViews();
      opts.onChange?.();
    }
    return state;
  }

  return {
    state,
    tick,
    broadcastViews,
    isHost: true,

    /** The host's own player acts without going near the network. */
    localIntent(intent, now = clock()) {
      if (!localPlayerId) return { ok: false, error: 'host-is-not-playing' };
      return applyIntent(state, localPlayerId, intent, now);
    },
    localView(now = state.t) {
      return localPlayerId ? viewFor(state, localPlayerId, now) : null;
    },

    start() {
      if (timer) return;
      timer = setInterval(() => tick(), TICK_MS);
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    close() {
      this.stop();
      transport.broadcast?.(encode({ t: MSG.BYE }));
      transport.close?.();
    },

    get connectedPlayers() { return [...playerToPeer.keys()]; },
    peerFor: (playerId) => playerToPeer.get(playerId),
  };
}
