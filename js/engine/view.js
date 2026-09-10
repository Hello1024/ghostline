/**
 * Fog of war.
 *
 * The host never broadcasts the whole world. Each player is sent only what
 * their role has earned, so opening devtools shows you nothing your screen
 * wasn't already going to show you. Every leak of a hidden ghost's position
 * would be a cheat, so this module is treated as a security boundary and is
 * covered by its own tests.
 */

import { PHASE, ROLE } from './constants.js';
import * as geo from './geo.js';
import { all, ghosts, hunters, located, zoneBounds } from './state.js';
import { derivedReveals, isDarkNow } from './engine.js';

/** How close a fellow ghost must be before you sense them. */
const GHOST_SIGHT_M = 200;

/**
 * Plain eyesight. Within this range you would simply see another player in the
 * street, so the game stops pretending otherwise and shows them live — to both
 * sides. It is what turns the last hundred metres into a chase you can read.
 */
const EYESIGHT_M = 35;

export function viewFor(state, playerId, now = state.t) {
  const me = state.players[playerId];
  if (!me) return null;
  const cfg = state.config;
  const over = state.phase === PHASE.OVER;
  // A caught player with infection off watches from the hunters' side, so
  // being out doesn't turn them into a free spotter for their old team.
  const eye = me.role === ROLE.SPECTATOR ? ROLE.HUNTER : me.role;

  const reveals = [...state.reveals, ...derivedReveals(state, now)]
    .filter((r) => r.until > now)
    .filter((r) => r.audience === 'all' || r.audience === eye || r.audience === playerId)
    .map((r) => projectReveal(state, r));

  const roster = all(state).map((p) => {
    const row = {
      id: p.id,
      name: p.name,
      role: p.role,
      connected: p.connected,
      dark: isDarkNow(state, p, now),
      score: Math.round(p.score),
      catches: p.catches,
      caches: p.caches,
      converting: p.convertAt > now ? p.convertAt : 0,
      items: p.id === playerId ? p.items : p.items.length,
    };
    if (over || canSee(state, me, eye, p, now)) {
      row.lat = p.lat; row.lon = p.lon; row.speed = round(p.speed, 2);
      row.heading = p.heading == null ? null : Math.round(p.heading);
      row.acc = p.acc;
    }
    return row;
  });

  const caches = state.caches
    .filter((c) => !c.takenBy)
    .filter((c) => over || (me.lat != null && geo.distance(c, me) <= cfg.cacheVisibleM))
    .map((c) => ({ id: c.id, lat: c.lat, lon: c.lon }));

  return {
    v: state.v,
    code: state.code,
    t: now,
    phase: state.phase,
    outcome: state.outcome,
    startedAt: state.startedAt,
    endsAt: state.endsAt,
    hostId: state.hostId,
    config: cfg,
    area: state.area,
    zone: state.zone,
    start: state.start,
    pulse: state.pulse,
    me: selfView(state, me, now),
    players: roster,
    caches,
    reveals,
    drones: eye === ROLE.HUNTER || over
      ? state.drones.filter((d) => d.until > now).map((d) => ({ id: d.id, lat: d.lat, lon: d.lon, radius: d.radius, until: d.until }))
      : [],
    traps: state.traps
      .filter((t) => over || t.role === me.role)
      .map((t) => ({ id: t.id, lat: t.lat, lon: t.lon, armedAt: t.armedAt, mine: t.by === playerId })),
    proximity: proximityFor(state, me, now),
    bearing: bearingFor(state, me, now),
    feed: state.feed
      .filter((e) => e.audience === 'all' || e.audience === playerId || e.audience === eye || e.audience == null)
      .slice(-24),
  };
}

function selfView(state, me, now) {
  const b = zoneBounds(state);
  return {
    id: me.id,
    name: me.name,
    role: me.role,
    lat: me.lat, lon: me.lon, acc: me.acc, speed: round(me.speed, 2), heading: me.heading,
    charge: Math.round(me.charge),
    items: me.items.slice(),
    fx: { ...me.fx },
    score: Math.round(me.score),
    catches: me.catches,
    caches: me.caches,
    distanceM: Math.round(me.distanceM),
    pulsesSurvived: me.pulsesSurvived,
    collecting: me.collecting,
    convertAt: me.convertAt,
    caughtBy: me.caughtBy,
    taggedBy: me.taggedBy,
    ready: me.ready,
    dark: {
      active: isDarkNow(state, me, now),
      since: me.dark.since,
      totalMs: Math.round(me.dark.totalMs),
      flaggedUntil: me.dark.flaggedUntil,
      jumps: me.dark.jumps,
    },
    oobSince: me.oobSince,
    outsideM: me.lat == null ? 0 : Math.round(geo.distanceOutside(b, me)),
    wakeLock: me.presence.wakeLock,
  };
}

/** May `me` see `p`'s exact position? */
function canSee(state, me, eye, p, now) {
  if (p.id === me.id) return true;
  if (p.lat == null) return false;
  if (p.role === ROLE.SPECTATOR) return false;
  // Eyesight beats every gadget, including a cloak: at this range you are
  // simply looking at each other.
  if (me.lat != null && geo.distance(me, p) <= EYESIGHT_M) return true;
  if (eye === ROLE.HUNTER) {
    // Hunters share a radio net: they always see each other, and nothing else.
    return p.role === ROLE.HUNTER;
  }
  // Ghosts are alone out there — they only sense another ghost close by.
  if (p.role === ROLE.GHOST && me.lat != null) {
    return geo.distance(me, p) <= GHOST_SIGHT_M;
  }
  return false;
}

/** A reveal is either a frozen snapshot or a live tail on a real player. */
function projectReveal(state, r) {
  const out = {
    id: r.id, kind: r.kind, blur: r.blur, until: r.until,
    heading: r.heading ?? null, decoy: r.decoy || null, from: r.from || null,
  };
  if (r.live && r.target && state.players[r.target]) {
    const t = state.players[r.target];
    out.lat = t.lat; out.lon = t.lon;
  } else {
    out.lat = r.lat; out.lon = r.lon;
  }
  return out;
}

/**
 * A directionless closeness cue. Both sides get one — the hunters' reaches
 * further, so pressure is asymmetric but nobody is ever ambushed blind.
 */
function proximityFor(state, me, now) {
  if (me.lat == null || me.role === ROLE.SPECTATOR) return { level: 'none', m: null };
  const cfg = state.config;
  const isHunter = me.role === ROLE.HUNTER;
  const targets = located(isHunter ? ghosts(state) : hunters(state))
    .filter((p) => p.convertAt === 0)
    .filter((p) => !(isHunter && p.fx.cloak > now));
  let best = Infinity;
  for (const p of targets) best = Math.min(best, geo.distance(me, p));
  const limit = isHunter ? cfg.proximityWarnM : 50;
  if (!Number.isFinite(best) || best > limit) return { level: 'none', m: null };
  if (best <= cfg.catchRadiusM) return { level: 'contact', m: null };
  if (best <= limit * 0.5) return { level: 'near', m: null };
  return { level: 'far', m: null };
}

/** Bloodhound: a bearing to the nearest ghost, and nothing else. */
function bearingFor(state, me, now) {
  if (me.role !== ROLE.HUNTER || me.fx.bloodhound <= now || me.lat == null) return null;
  let best = null;
  let bestD = Infinity;
  for (const g of located(ghosts(state))) {
    if (g.fx.cloak > now || g.convertAt > now) continue;
    const d = geo.distance(me, g);
    if (d < bestD) { bestD = d; best = g; }
  }
  if (!best) return null;
  return { deg: Math.round(geo.bearing(me, best)), until: me.fx.bloodhound };
}

const round = (n, dp) => (n == null ? n : Math.round(n * 10 ** dp) / 10 ** dp);

/** Final standings, sorted. Used by the scoreboard and the tests. */
export function leaderboard(state) {
  return all(state)
    .map((p) => ({
      id: p.id, name: p.name, role: p.role,
      score: Math.round(p.score),
      catches: p.catches, caches: p.caches,
      distanceM: Math.round(p.distanceM),
      pulsesSurvived: p.pulsesSurvived,
      darkS: Math.round(p.dark.totalMs / 1000),
      jumps: p.dark.jumps,
      caughtAt: p.caughtAt,
    }))
    .sort((a, b) => b.score - a.score);
}
