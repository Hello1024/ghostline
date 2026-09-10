/** Shared scaffolding for engine tests: build a game, place people, tick it. */
import { createGame, addPlayer, spawnCaches } from '../js/engine/state.js';
import { applyIntent, step } from '../js/engine/engine.js';
import * as geo from '../js/engine/geo.js';

export const T0 = 1_700_000_000_000;
export const CENTRE = { lat: 51.5074, lon: -0.1278 };

/**
 * @param {{players?:string[], roles?:object, config?:object, seed?:string}} opts
 */
export function makeGame(opts = {}) {
  const { players = ['h1', 'g1'], roles = { h1: 'hunter', g1: 'ghost' }, config = {}, seed = 'test' } = opts;
  const state = createGame({
    seed, area: CENTRE, now: T0, hostId: players[0], code: 'TEST',
    config: { durationS: 1800, ...config },
  });
  for (const id of players) {
    addPlayer(state, { id, name: id });
    state.players[id].role = roles[id] || 'ghost';
  }
  return state;
}

/** Put a player at an east/north offset from the play-area centre. */
export function place(state, id, eastM, northM, now = state.t, acc = 5) {
  const p = geo.offset(CENTRE, eastM, northM);
  applyIntent(state, id, { type: 'fix', lat: p.lat, lon: p.lon, acc, at: now }, now);
  return p;
}

export function start(state, now = T0) {
  const r = applyIntent(state, state.hostId, { type: 'start', start: CENTRE }, now);
  if (!r.ok) throw new Error(`start failed: ${r.error}`);
  return r;
}

/** Advance the clock in `stepMs` slices, optionally doing work each slice. */
export function run(state, ms, { stepMs = 500, each = null, from = null } = {}) {
  let now = from ?? state.t;
  const end = now + ms;
  while (now < end) {
    now = Math.min(end, now + stepMs);
    if (each) each(now);
    step(state, now);
  }
  return now;
}

/** Keep everyone talking, so nobody is judged to have gone dark. */
export function heartbeat(state, now, ids = Object.keys(state.players)) {
  for (const id of ids) {
    const p = state.players[id];
    if (p.lat == null) continue;
    applyIntent(state, id, { type: 'fix', lat: p.lat, lon: p.lon, acc: 5, at: now }, now);
  }
}

export const give = (state, id, ...items) => { state.players[id].items.push(...items); };
export const charge = (state, id, v) => { state.players[id].charge = v; };
export const feedTypes = (state) => state.feed.map((e) => e.type);
export const hasFeed = (state, type) => state.feed.some((e) => e.type === type);

/** Structural invariants that must hold after every single tick, forever. */
export function checkInvariants(state, where = '') {
  const cfg = state.config;
  const problems = [];
  const bad = (msg) => problems.push(`${where}: ${msg}`);

  if (!['lobby', 'scatter', 'hunt', 'collapse', 'over'].includes(state.phase)) bad(`phase ${state.phase}`);
  if (!(state.zone.sizeM > 0 && state.zone.sizeM <= cfg.areaSizeM + 1)) bad(`zone ${state.zone.sizeM}`);
  if (!Number.isFinite(state.t)) bad('clock is not a number');

  const ids = new Set();
  for (const r of state.reveals) {
    if (ids.has(r.id)) bad(`duplicate reveal id ${r.id}`);
    ids.add(r.id);
    if (r.lat != null && !Number.isFinite(r.lat)) bad(`reveal ${r.id} lat`);
  }

  for (const p of Object.values(state.players)) {
    if (!['ghost', 'hunter', 'spectator'].includes(p.role)) bad(`${p.id} role ${p.role}`);
    if (!Number.isFinite(p.charge) || p.charge < 0 || p.charge > cfg.chargeMax + 0.001) bad(`${p.id} charge ${p.charge}`);
    if (p.items.length > cfg.inventorySize) bad(`${p.id} holds ${p.items.length} items`);
    if (!Number.isFinite(p.score) || p.score < 0) bad(`${p.id} score ${p.score}`);
    if (!Number.isFinite(p.distanceM) || p.distanceM < 0) bad(`${p.id} distance ${p.distanceM}`);
    if (p.lat != null && (!Number.isFinite(p.lat) || Math.abs(p.lat) > 90)) bad(`${p.id} lat ${p.lat}`);
    if (p.lon != null && (!Number.isFinite(p.lon) || Math.abs(p.lon) > 180)) bad(`${p.id} lon ${p.lon}`);
    if (!Number.isFinite(p.dark.totalMs) || p.dark.totalMs < 0) bad(`${p.id} dark ledger ${p.dark.totalMs}`);
    for (const [k, v] of Object.entries(p.fx)) {
      if (!Number.isFinite(v) || v < 0) bad(`${p.id} fx.${k} = ${v}`);
    }
  }

  for (const c of state.caches) {
    if (!Number.isFinite(c.lat) || !Number.isFinite(c.lon)) bad(`cache ${c.id} position`);
  }
  return problems;
}

/** A stable fingerprint of the whole world, for determinism checks. */
export function fingerprint(state) {
  return JSON.stringify(state, (k, v) => (typeof v === 'number' && !Number.isInteger(v) ? Math.round(v * 1e6) / 1e6 : v));
}
