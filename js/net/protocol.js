/**
 * Wire protocol.
 *
 * One host device owns the world; everyone else sends intents and receives a
 * personalised view. Messages are small JSON objects. Everything arriving from
 * a peer is validated here before it reaches the engine - the engine is strict
 * too, but a malformed message should never get that far.
 */

export const PROTOCOL_VERSION = 1;

/** Anything larger than this from a peer is dropped unread. */
export const MAX_MESSAGE_BYTES = 64 * 1024;

export const MSG = Object.freeze({
  HELLO: 'hello',       // client -> host: who I am
  WELCOME: 'welcome',   // host -> client: you are in
  INTENT: 'intent',     // client -> host: I would like to do a thing
  VIEW: 'view',         // host -> client: here is your world
  ERROR: 'error',       // host -> client: that did not work
  BYE: 'bye',           // either way: I am leaving
  PING: 'ping',
  PONG: 'pong',
});

const INTENT_TYPES = new Set([
  'fix', 'presence', 'name', 'ready', 'use',
  'config', 'area', 'setRole', 'start', 'end',
]);

export function encode(msg) {
  return JSON.stringify(msg);
}

/**
 * Parse and sanity-check a message off the wire.
 * @returns {{ok:true, msg:object}|{ok:false, error:string}}
 */
export function decode(raw) {
  if (typeof raw !== 'string') {
    // Some transports hand back an already-parsed object.
    if (raw && typeof raw === 'object') return validate(raw);
    return fail('not-a-message');
  }
  if (raw.length > MAX_MESSAGE_BYTES) return fail('too-big');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return fail('bad-json');
  }
  return validate(parsed);
}

function validate(msg) {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return fail('not-an-object');
  if (typeof msg.t !== 'string') return fail('no-type');
  switch (msg.t) {
    case MSG.HELLO:
      if (!isId(msg.playerId)) return fail('bad-player-id');
      return okMsg({ t: MSG.HELLO, playerId: msg.playerId, name: cleanName(msg.name), v: msg.v });
    case MSG.WELCOME:
      if (!isId(msg.playerId)) return fail('bad-player-id');
      return okMsg({ t: MSG.WELCOME, playerId: msg.playerId, code: String(msg.code || '').slice(0, 8), v: msg.v });
    case MSG.INTENT: {
      const i = msg.i;
      if (!i || typeof i !== 'object' || Array.isArray(i)) return fail('bad-intent');
      if (!INTENT_TYPES.has(i.type)) return fail('unknown-intent');
      return okMsg({ t: MSG.INTENT, i: sanitiseIntent(i) });
    }
    case MSG.VIEW:
      if (!msg.view || typeof msg.view !== 'object') return fail('bad-view');
      return okMsg({ t: MSG.VIEW, view: msg.view });
    case MSG.ERROR:
      return okMsg({ t: MSG.ERROR, error: String(msg.error || 'unknown').slice(0, 120) });
    case MSG.BYE:
      return okMsg({ t: MSG.BYE });
    case MSG.PING:
      return okMsg({ t: MSG.PING, at: num(msg.at) });
    case MSG.PONG:
      return okMsg({ t: MSG.PONG, at: num(msg.at), hostNow: num(msg.hostNow) });
    default:
      return fail('unknown-type');
  }
}

/** Strip an intent down to the fields its type is allowed to carry. */
function sanitiseIntent(i) {
  switch (i.type) {
    case 'fix':
      return { type: 'fix', lat: num(i.lat), lon: num(i.lon), acc: num(i.acc), at: num(i.at) };
    case 'presence':
      return { type: 'presence', visible: !!i.visible, wakeLock: !!i.wakeLock };
    case 'name':
      return { type: 'name', value: cleanName(i.value) };
    case 'ready':
      return { type: 'ready', value: !!i.value };
    case 'use':
      return {
        type: 'use',
        item: typeof i.item === 'string' ? i.item.slice(0, 32) : '',
        params: i.params && typeof i.params === 'object'
          ? { lat: num(i.params.lat), lon: num(i.params.lon) }
          : {},
      };
    case 'config':
      // The engine clamps these; here we only insist it is a flat object.
      return { type: 'config', config: flatObject(i.config) };
    case 'area':
      return { type: 'area', lat: num(i.lat), lon: num(i.lon), sizeM: num(i.sizeM) };
    case 'setRole':
      return { type: 'setRole', target: isId(i.target) ? i.target : '', role: String(i.role || '').slice(0, 16) };
    case 'start':
      return {
        type: 'start',
        start: i.start && typeof i.start === 'object' ? { lat: num(i.start.lat), lon: num(i.start.lon) } : null,
      };
    case 'end':
      return { type: 'end' };
    default:
      return { type: i.type };
  }
}

/** Copy only own, primitive-valued keys - no prototypes, no nesting. */
function flatObject(o) {
  const out = {};
  if (!o || typeof o !== 'object') return out;
  for (const key of Object.keys(o)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    const v = o[key];
    const t = typeof v;
    if (t === 'number' || t === 'boolean' || t === 'string') out[key] = v;
  }
  return out;
}

/** Control characters have no business in a display name. */
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/g;

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : undefined);
const isId = (v) => typeof v === 'string' && v.length > 0 && v.length <= 64 && /^[A-Za-z0-9_-]+$/.test(v);
const cleanName = (v) => String(v ?? '').replace(CONTROL_CHARS, '').trim().slice(0, 16);
const okMsg = (msg) => ({ ok: true, msg });
const fail = (error) => ({ ok: false, error });

export { isId, cleanName };
