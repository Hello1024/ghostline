/**
 * Game state: construction and small pure helpers.
 *
 * The whole world is one plain JSON-serialisable object. That is deliberate —
 * the host broadcasts slices of it, tests snapshot it, and a replay can be
 * diffed against a live run to prove the engine is deterministic.
 */

import { DEFAULT_CONFIG, normaliseConfig, PHASE, ROLE } from './constants.js';
import { hashSeed, mkRng } from './rng.js';
import * as geo from './geo.js';

export function createPlayer({ id, name, role = ROLE.GHOST, now = 0 }) {
  return {
    id,
    name: String(name || 'Player').slice(0, 16),
    role,
    joinedAt: now,
    ready: false,
    connected: true,
    lastMsgAt: now,

    // position
    lat: null, lon: null, acc: null, fixAt: 0,
    speed: 0, heading: null,

    // resources
    charge: DEFAULT_CONFIG.chargeStart,
    items: [],
    fx: { cloak: 0, static: 0, scout: 0, bloodhound: 0, dragnet: 0, lockout: 0 },

    // the blackout ledger
    dark: { since: 0, awake: true, wokeAt: 0, mark: null, totalMs: 0, flaggedUntil: 0, jumps: 0 },
    presence: { visible: true, wakeLock: false },

    // progress
    score: 0, caches: 0, catches: 0, distanceM: 0, pulsesSurvived: 0,
    caughtAt: 0, caughtBy: null, convertAt: 0,
    oobSince: 0,
    collecting: null,
    taggedBy: null, taggedSince: 0,
  };
}

/**
 * @param {{seed?:string|number, area:{lat:number,lon:number}, config?:object,
 *          hostId?:string, now?:number, code?:string}} opts
 */
/**
 * Summarise a ring for everything that wants a single point or size: map
 * fitting, zoom, the bot's sense of "roughly how big is this". `sizeM` is the
 * side of a square of the same area, so it stays meaningful for any shape.
 */
export function shapeFrom(polygon) {
  const ring = (polygon || []).filter((p) => Number.isFinite(p?.lat) && Number.isFinite(p?.lon));
  if (ring.length < 3) return { polygon: ring, lat: 0, lon: 0, sizeM: 0, areaM2: 0 };
  const centre = geo.polygonCentroid(ring);
  const areaM2 = geo.polygonArea(ring);
  return {
    polygon: ring.map((p) => ({ lat: p.lat, lon: p.lon })),
    lat: centre.lat,
    lon: centre.lon,
    sizeM: Math.sqrt(areaM2),
    areaM2,
  };
}

export function createGame(opts = {}) {
  const now = opts.now ?? Date.now();
  const config = normaliseConfig(opts.config);
  const seed = typeof opts.seed === 'string' ? hashSeed(opts.seed) : (opts.seed ?? 0x9e3779b9);
  // A play area is a polygon. When only a centre is given we start from a
  // square of the configured size, which the host can then reshape.
  const centre = { lat: opts.area?.lat ?? 0, lon: opts.area?.lon ?? 0 };
  const ring = opts.area?.polygon?.length >= 3
    ? opts.area.polygon
    : geo.squarePolygon(centre, opts.area?.sizeM || config.areaSizeM);
  const area = shapeFrom(ring);
  return {
    v: 1,
    code: opts.code || '----',
    seed,
    rngState: seed >>> 0,
    nextId: 1,
    t: now,
    createdAt: now,
    startedAt: 0,
    endsAt: 0,
    phase: PHASE.LOBBY,
    outcome: null,
    hostId: opts.hostId || null,
    config,
    area,
    zone: { ...area, scale: 1 },
    start: null,          // where the hunters are held during scatter
    players: {},
    caches: [],
    decoys: [],
    traps: [],
    drones: [],
    reveals: [],
    pulse: { lastAt: 0, nextAt: 0, count: 0 },
    feed: [],
    seq: 0,
  };
}

export function addPlayer(state, { id, name, role }) {
  if (state.players[id]) {
    const p = state.players[id];
    p.connected = true;
    p.lastMsgAt = state.t;
    if (name) p.name = String(name).slice(0, 16);
    return p;
  }
  if (Object.keys(state.players).length >= state.config.maxPlayers) return null;
  const p = createPlayer({ id, name, role: role || ROLE.GHOST, now: state.t });
  p.charge = state.config.chargeStart;
  state.players[id] = p;
  return p;
}

export const zonePolygon = (state) => state.zone.polygon;
export const areaPolygon = (state) => state.area.polygon;

export function zoneBounds(state) {
  return geo.polygonBounds(state.zone.polygon);
}

export function areaBounds(state) {
  return geo.polygonBounds(state.area.polygon);
}

export const all = (state) => Object.values(state.players);
export const ghosts = (state) => all(state).filter((p) => p.role === ROLE.GHOST);
export const hunters = (state) => all(state).filter((p) => p.role === ROLE.HUNTER);
export const active = (state) => all(state).filter((p) => p.role !== ROLE.SPECTATOR);
export const located = (list) => list.filter((p) => p.lat != null && p.lon != null);

/** Is this player currently being penalised for a dark screen? */
export function isDark(state, p, now = state.t) {
  return !!p.dark.since && (now - p.dark.since) > state.config.darkGraceS * 1000;
}

/** Randomly pick hunters, leaving everyone else a ghost. */
export function assignRoles(state, hunterCount) {
  const rng = mkRng(state);
  const pool = all(state).filter((p) => p.role !== ROLE.SPECTATOR);
  const n = Math.max(1, Math.min(pool.length - 1, hunterCount | 0));
  for (const p of pool) p.role = ROLE.GHOST;
  const shuffled = pool.slice();
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = rng.int(i + 1);
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  for (let i = 0; i < n; i++) shuffled[i].role = ROLE.HUNTER;
  return shuffled.slice(0, n).map((p) => p.id);
}

/** Fill the field with caches at random points inside the current zone. */
export function spawnCaches(state) {
  const rng = mkRng(state);
  const poly = zonePolygon(state);
  state.caches = [];
  for (let i = 0; i < state.config.cacheCount; i++) {
    const p = geo.randomPointInPolygon(poly, rng);
    state.caches.push({ id: `c${state.nextId++}`, lat: p.lat, lon: p.lon, takenBy: null, respawnAt: 0 });
  }
  return state.caches;
}

/** Append to the event feed, keeping it bounded. */
export function log(state, event) {
  state.feed.push({ id: state.seq++, t: state.t, ...event });
  if (state.feed.length > 60) state.feed.splice(0, state.feed.length - 60);
}
