/**
 * The client session.
 *
 * Sends intents, receives views, and keeps a rough estimate of the host's
 * clock so countdowns agree across devices. It holds no authority at all: if
 * the host says you were caught, you were caught.
 */

import { MSG, PROTOCOL_VERSION, decode, encode } from './protocol.js';

export function createClient({ transport, playerId, name, onView, onEvent, clock = () => Date.now() }) {
  let view = null;
  let welcomed = false;
  let offset = 0;          // hostNow - localNow
  let rtt = null;
  let pingTimer = null;

  transport.on({
    onMessage(raw) {
      const parsed = decode(raw);
      if (!parsed.ok) { onEvent?.({ type: 'bad-message', error: parsed.error }); return; }
      const msg = parsed.msg;
      switch (msg.t) {
        case MSG.WELCOME:
          welcomed = true;
          onEvent?.({ type: 'welcome', code: msg.code });
          break;
        case MSG.VIEW:
          view = msg.view;
          onView?.(view);
          break;
        case MSG.ERROR:
          onEvent?.({ type: 'error', error: msg.error });
          break;
        case MSG.PONG: {
          const now = clock();
          rtt = now - msg.at;
          // Assume the trip was symmetric; good enough for a countdown.
          offset = msg.hostNow + rtt / 2 - now;
          break;
        }
        case MSG.BYE:
          onEvent?.({ type: 'bye' });
          break;
        default:
          break;
      }
    },
    onOpen() { hello(); },
    onClose() { welcomed = false; onEvent?.({ type: 'closed' }); },
  });

  function hello() {
    transport.send(encode({ t: MSG.HELLO, playerId, name, v: PROTOCOL_VERSION }));
  }

  function send(intent) {
    return transport.send(encode({ t: MSG.INTENT, i: intent }));
  }

  return {
    isHost: false,
    playerId,
    hello,
    send,
    /** How this connection is routed — for the in-match diagnostics. */
    transportRoute: () => (typeof transport.route === 'function' ? transport.route() : null),
    get view() { return view; },
    get welcomed() { return welcomed; },
    get rtt() { return rtt; },
    /** The host's clock, as best we can tell. */
    hostNow: () => clock() + offset,
    ping() { transport.send(encode({ t: MSG.PING, at: clock() })); },
    start() {
      hello();
      if (!pingTimer) pingTimer = setInterval(() => this.ping(), 5000);
    },
    stop() { if (pingTimer) clearInterval(pingTimer); pingTimer = null; },
    close() {
      this.stop();
      transport.send(encode({ t: MSG.BYE }));
      transport.close?.();
    },
  };
}
