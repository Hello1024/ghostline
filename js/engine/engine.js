/**
 * The rules engine.
 *
 * Two entry points, both pure-ish (they mutate the state you hand them and
 * nothing else — no clocks, no I/O, no randomness that isn't seeded):
 *
 *   applyIntent(state, playerId, intent, now) — a player asked for something
 *   step(state, now)                          — advance the world to `now`
 *
 * Because `now` is always an argument, a test can run thirty simulated minutes
 * in a millisecond, and the host and a replay of the same intents agree.
 */

import { CONFIG_SCHEMA, PHASE, ROLE, hostConfigPatch } from './constants.js';
import { mkRng } from './rng.js';
import * as geo from './geo.js';
import { ITEMS, canHold, rollLoot } from './items.js';
import {
  addPlayer, all, active, ghosts, hunters, log, located,
  shapeFrom, spawnCaches, zonePolygon, areaPolygon,
} from './state.js';

const S = 1000;

// ---------------------------------------------------------------- intents --

/**
 * @returns {{ok:boolean, error?:string}}
 */
export function applyIntent(state, playerId, intent, now = state.t) {
  const p = state.players[playerId];
  if (!intent || typeof intent.type !== 'string') return err('bad-intent');
  if (!p && intent.type !== 'join') return err('no-such-player');
  if (p) {
    p.lastMsgAt = now;
    p.connected = true;
  }

  switch (intent.type) {
    case 'join': {
      const added = addPlayer(state, { id: playerId, name: intent.name, role: intent.role });
      return added ? ok() : err('game-full');
    }

    case 'fix':
      return applyFix(state, p, intent, now);

    case 'presence': {
      const visible = !!intent.visible;
      p.presence.visible = visible;
      p.presence.wakeLock = !!intent.wakeLock;
      if (visible && p.dark.since && !p.dark.awake) {
        p.dark.awake = true;
        p.dark.wokeAt = now;
      }
      return ok();
    }

    case 'name':
      p.name = String(intent.value || '').slice(0, 16) || p.name;
      return ok();

    case 'ready':
      p.ready = !!intent.value;
      return ok();

    case 'use':
      return useItem(state, p, intent, now);

    // ---- host-only ----
    case 'config': {
      if (!isHost(state, playerId)) return err('not-host');
      if (state.phase !== PHASE.LOBBY) return err('already-started');
      // Never trust the wire: only known dials, each clamped to its bounds.
      Object.assign(state.config, hostConfigPatch(intent.config));
      state.config.collapseS = Math.min(
        state.config.collapseS,
        Math.max(0, state.config.durationS - state.config.scatterS),
      );
      state.area.sizeM = state.config.areaSizeM;
      state.zone.sizeM = state.config.areaSizeM;
      return ok();
    }
    case 'area': {
      if (!isHost(state, playerId)) return err('not-host');
      if (state.phase !== PHASE.LOBBY) return err('already-started');
      return setArea(state, intent);
    }
    case 'setRole': {
      if (!isHost(state, playerId)) return err('not-host');
      if (state.phase !== PHASE.LOBBY) return err('already-started');
      const target = state.players[intent.target];
      if (!target) return err('no-such-player');
      if (![ROLE.GHOST, ROLE.HUNTER, ROLE.SPECTATOR].includes(intent.role)) return err('bad-role');
      target.role = intent.role;
      return ok();
    }
    case 'start': {
      if (!isHost(state, playerId)) return err('not-host');
      if (state.phase !== PHASE.LOBBY) return err('already-started');
      return startGame(state, now, intent);
    }
    case 'end': {
      if (!isHost(state, playerId)) return err('not-host');
      finish(state, now, 'aborted');
      return ok();
    }

    default:
      return err('unknown-intent');
  }
}

/**
 * Adopt a play area. The shape may be any simple polygon the host drew; a bare
 * centre still works and becomes a square of the configured size.
 */
function setArea(state, intent) {
  let ring = Array.isArray(intent.polygon) ? intent.polygon : null;
  if (!ring && Number.isFinite(intent.lat) && Number.isFinite(intent.lon)) {
    const { min, max } = CONFIG_SCHEMA.areaSizeM;
    const size = Number.isFinite(intent.sizeM)
      ? Math.min(max, Math.max(min, intent.sizeM))
      : state.config.areaSizeM;
    state.config.areaSizeM = size;
    ring = geo.squarePolygon({ lat: intent.lat, lon: intent.lon }, size);
  }
  const problem = polygonProblem(ring);
  if (problem) return err(problem);
  const shape = shapeFrom(ring);
  state.area = shape;
  state.zone = { ...shape, scale: 1 };
  return ok();
}

/** Why this ring cannot be a play area, or null if it can. */
export function polygonProblem(ring) {
  if (!Array.isArray(ring) || ring.length < 3) return 'bad-area';
  if (ring.length > MAX_VERTICES) return 'too-many-corners';
  for (const p of ring) {
    if (!p || !Number.isFinite(p.lat) || !Number.isFinite(p.lon)) return 'bad-area';
    if (Math.abs(p.lat) > 90 || Math.abs(p.lon) > 180) return 'bad-area';
  }
  // A shape that spans continents is a mistake, not a game.
  if (geo.polygonPerimeter(ring) > 60000) return 'area-too-big';
  // Simplicity comes first: a ring that crosses itself has no meaningful area
  // to measure — the halves cancel — so it would otherwise be reported as too
  // small, which tells the host nothing about what is actually wrong.
  if (!geo.isSimplePolygon(ring)) return 'area-crosses-itself';
  const areaM2 = geo.polygonArea(ring);
  if (areaM2 < MIN_AREA_M2) return 'area-too-small';
  if (areaM2 > MAX_AREA_M2) return 'area-too-big';
  return null;
}

/** Bounds on a drawn area: small enough to walk, big enough to hide in. */
export const MAX_VERTICES = 60;
export const MIN_AREA_M2 = 40_000;         // 200m x 200m
export const MAX_AREA_M2 = 25_000_000;     // 5km x 5km

const ok = () => ({ ok: true });
const err = (error) => ({ ok: false, error });
const isHost = (state, id) => state.hostId === id;

/** Position report. Also where we credit charge and catch teleports. */
function applyFix(state, p, intent, now) {
  const { lat, lon } = intent;
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    return err('bad-fix');
  }
  const acc = Number.isFinite(intent.acc) ? Math.max(0, intent.acc) : 999;
  const at = Number.isFinite(intent.at) ? intent.at : now;
  const prev = p.lat != null ? { lat: p.lat, lon: p.lon } : null;
  const dtS = p.fixAt ? Math.max(0.001, (at - p.fixAt) / S) : 0;

  // Resolve any pending blackout jump before we overwrite the position.
  resolveDarkFix(state, p, { lat, lon }, now);

  if (prev && dtS > 0) {
    const d = geo.distance(prev, { lat, lon });
    const inst = d / dtS;
    if (inst <= state.config.maxSpeedMs) {
      p.speed = p.speed ? p.speed * 0.6 + inst * 0.4 : inst;
      if (d > 0.5) p.heading = geo.bearing(prev, { lat, lon });
      // Charge is the reward for walking. Bad fixes and dead phases earn none.
      if (isRunning(state) && acc <= state.config.maxAccuracyM) {
        p.distanceM += d;
        if (!isDarkNow(state, p, now)) {
          p.charge = Math.min(state.config.chargeMax, p.charge + d * state.config.chargePerMetre);
        }
      }
    } else {
      // Physically impossible: a spoof, a car, or a fix after a long gap.
      p.speed = 0;
      log(state, { type: 'jump', who: p.id, audience: p.id, metres: Math.round(d) });
    }
  }
  p.lat = lat;
  p.lon = lon;
  p.acc = acc;
  p.fixAt = at;
  return ok();
}

/** Spend an item. Costs an inventory slot *and* charge. */
function useItem(state, p, intent, now) {
  const item = ITEMS[intent.item];
  if (!item) return err('no-such-item');
  if (!isRunning(state)) return err('not-running');
  if (p.role === ROLE.SPECTATOR) return err('spectating');
  if (p.convertAt > now) return err('converting');
  if (p.fx.lockout > now && !item.ignoresLockout) return err('locked-out');
  const slot = p.items.indexOf(item.id);
  if (slot < 0) return err('not-held');
  if (!canHold(p.role, item.id)) return err('wrong-role');
  if (p.charge < item.cost) return err('not-enough-charge');
  if (p.lat == null) return err('no-fix');

  p.items.splice(slot, 1);
  p.charge -= item.cost;
  const rng = mkRng(state);
  item.apply({
    state, player: p, rng, now,
    params: intent.params || {},
    log: (e) => log(state, { ...e, audience: e.audience ?? p.id }),
    addReveal: (r) => addReveal(state, { ...r, from: p.id }, now),
  });
  log(state, { type: 'use', who: p.id, item: item.id, audience: p.id });
  return ok();
}

// ------------------------------------------------------------ life cycle --

function startGame(state, now, intent = {}) {
  const roster = active(state);
  if (roster.length < 2) return err('need-two-players');
  if (!state.area.polygon || state.area.polygon.length < 3) return err('no-area');
  if (!hunters(state).length) return err('need-a-hunter');
  if (!ghosts(state).length) return err('need-a-ghost');

  state.phase = PHASE.SCATTER;
  state.startedAt = now;
  state.endsAt = now + state.config.durationS * S;
  state.zone = { ...state.area, scale: 1 };
  // Hunters are held near wherever the pack starts out.
  const anchor = located(roster)[0];
  state.start = intent.start || (anchor ? { lat: anchor.lat, lon: anchor.lon } : { lat: state.area.lat, lon: state.area.lon });
  spawnCaches(state);
  state.pulse = { lastAt: 0, nextAt: now + state.config.scatterS * S, count: 0 };
  for (const p of roster) {
    p.charge = state.config.chargeStart;
    p.items = [];
    p.score = 0;
    p.dark = { since: 0, awake: true, wokeAt: 0, mark: null, totalMs: 0, flaggedUntil: 0, jumps: 0 };
  }
  log(state, { type: 'start', hunters: hunters(state).map((h) => h.id) });
  return ok();
}

function finish(state, now, outcome) {
  if (state.phase === PHASE.OVER) return;
  state.phase = PHASE.OVER;
  state.outcome = outcome;
  state.endsAt = Math.min(state.endsAt || now, now);
  if (outcome === 'ghosts') {
    for (const g of ghosts(state)) g.score += state.config.scoreGhostSurvive;
  } else if (outcome === 'hunters') {
    const minsLeft = Math.max(0, (state.startedAt + state.config.durationS * S - now) / 60000);
    for (const h of hunters(state)) h.score += Math.round(minsLeft * state.config.scoreSweepPerMinLeft);
  }
  log(state, { type: 'over', outcome });
}

export const isRunning = (state) =>
  state.phase === PHASE.SCATTER || state.phase === PHASE.HUNT || state.phase === PHASE.COLLAPSE;

// -------------------------------------------------------------- the tick --

export function step(state, now = state.t) {
  const dt = Math.max(0, Math.min(5, (now - state.t) / S));
  state.t = now;
  if (!isRunning(state)) return state;

  advancePhase(state, now);
  for (const p of all(state)) updatePlayer(state, p, now, dt);
  updateZone(state, now);
  updateCaches(state, now, dt);
  updateDecoys(state, now, dt);
  if (state.pulse.nextAt && now >= state.pulse.nextAt) pulse(state, now);
  updateTraps(state, now);
  updateCatches(state, now);
  prune(state, now);
  checkEnd(state, now);
  return state;
}

function advancePhase(state, now) {
  const collapseAt = state.endsAt - state.config.collapseS * S;
  const huntAt = state.startedAt + state.config.scatterS * S;
  let next = state.phase;
  if (now >= collapseAt && state.config.collapseS > 0) next = PHASE.COLLAPSE;
  else if (now >= huntAt) next = PHASE.HUNT;
  else next = PHASE.SCATTER;
  if (next !== state.phase) {
    state.phase = next;
    log(state, { type: 'phase', phase: next });
  }
}

/** The zone shrinks steadily through the collapse phase. */
function updateZone(state, now) {
  const { collapseS, zoneShrinkTo } = state.config;
  if (!collapseS) return;
  const collapseAt = state.endsAt - collapseS * S;
  const progress = Math.max(0, Math.min(1, (now - collapseAt) / (collapseS * S)));
  // `zoneShrinkTo` is a linear scale — each edge is pulled in to that fraction,
  // so the area falls with its square. The balance was tuned against this.
  const scale = 1 - (1 - zoneShrinkTo) * progress;
  if (Math.abs(scale - state.zone.scale) < 1e-4) return;
  const shrunk = geo.scalePolygon(state.area.polygon, scale, {
    lat: state.area.lat, lon: state.area.lon,
  });
  state.zone = { ...shapeFrom(shrunk), scale };
}

function updatePlayer(state, p, now, dt) {
  const cfg = state.config;

  // Conversion freeze after being caught.
  if (p.convertAt && now >= p.convertAt) p.convertAt = 0;

  updateDark(state, p, now, dt);

  // Effects are cancelled the moment you go dark — no cloaking in your pocket.
  if (isDarkNow(state, p, now)) {
    p.fx.cloak = 0; p.fx.scout = 0; p.fx.bloodhound = 0; p.fx.dragnet = 0;
  }

  // Out of bounds.
  const outside = p.lat != null && !geo.pointInPolygon(zonePolygon(state), p);
  if (outside && p.role !== ROLE.SPECTATOR) {
    if (!p.oobSince) {
      p.oobSince = now;
    } else if (now - p.oobSince > cfg.oobGraceS * S) {
      p.charge = Math.max(0, p.charge - cfg.oobDrainPerS * dt);
      ensureReveal(state, {
        kind: 'oob', target: p.id, audience: opposing(p.role), blur: 0, live: true,
      }, now, 3 * S);
    }
  } else if (p.oobSince) {
    p.oobSince = 0;
  }

  // Ghost survival scoring: only while lit, in bounds and actually playing.
  if (p.role === ROLE.GHOST && !isDarkNow(state, p, now) && !outside &&
      state.phase !== PHASE.SCATTER && p.convertAt === 0) {
    p.score += cfg.scoreGhostPerS * dt;
  }

  // A hunter who wanders off during scatter gets lit up for everyone.
  if (state.phase === PHASE.SCATTER && p.role === ROLE.HUNTER && p.lat != null && state.start) {
    if (geo.distance(p, state.start) > 75) {
      ensureReveal(state, { kind: 'falsestart', target: p.id, audience: ROLE.GHOST, blur: 0, live: true }, now, 5 * S);
    }
  }
}

/**
 * The blackout rule.
 *
 * A player is "dark" when their client stops reporting — either it told us the
 * screen went away, or it simply went quiet. The second test is the important
 * one: it does not rely on a cheating client being honest about it.
 */
function updateDark(state, p, now, dt) {
  const cfg = state.config;
  if (p.role === ROLE.SPECTATOR) return;
  const quiet = now - p.lastMsgAt > cfg.fixTimeoutS * S;
  const dark = !p.presence.visible || quiet || !p.connected;

  if (dark) {
    if (!p.dark.since) {
      p.dark.since = now;
      p.dark.awake = false;
      p.dark.wokeAt = 0;
      p.dark.mark = p.lat != null ? { lat: p.lat, lon: p.lon, at: now } : null;
    }
    if (now - p.dark.since > cfg.darkGraceS * S) {
      p.dark.totalMs += dt * S;
      p.charge = Math.max(0, p.charge - cfg.darkDrainPerS * dt);
      // Your position is broadcast to the other side for as long as you stay away.
      ensureReveal(state, {
        kind: 'dark', target: p.id, audience: opposing(p.role), blur: 0, live: true,
      }, now, 3 * S);
    }
  } else if (p.dark.since) {
    // Awake and talking again. If a fix never arrives to explain the gap,
    // give up on the jump check after a grace window.
    if (!p.dark.awake) { p.dark.awake = true; p.dark.wokeAt = now; }
    if (now - p.dark.wokeAt > 15 * S) clearDark(state, p, now);
  }
}

/** Called when a fresh fix lands, to judge how far someone moved while away. */
function resolveDarkFix(state, p, pos, now) {
  const cfg = state.config;
  if (!p.dark.since || !p.dark.mark) return;
  const wokeAt = p.dark.wokeAt || now;
  const darkS = (wokeAt - p.dark.since) / S;
  if (!p.dark.awake && !p.presence.visible) return; // still away — nothing to judge yet
  if (darkS > cfg.darkGraceS) {
    const moved = geo.distance(p.dark.mark, pos);
    const allowed = cfg.darkWalkSpeedMs * darkS + cfg.darkSlackM;
    if (moved > allowed) {
      // Unexplained ground covered with the screen off: light them up.
      p.dark.flaggedUntil = now + cfg.ghostFlagS * S;
      p.dark.jumps += 1;
      p.fx.lockout = Math.max(p.fx.lockout, now + cfg.ghostFlagS * S);
      p.fx.cloak = 0;
      addReveal(state, {
        kind: 'flag', target: p.id, audience: opposing(p.role), blur: 0, live: true,
        until: p.dark.flaggedUntil,
      }, now);
      log(state, {
        type: 'flag', who: p.id, audience: 'all',
        metres: Math.round(moved), seconds: Math.round(darkS),
      });
    }
  }
  clearDark(state, p, now);
}

function clearDark(state, p, now) {
  p.dark.since = 0;
  p.dark.mark = null;
  p.dark.awake = true;
  p.dark.wokeAt = 0;
  for (const r of state.reveals) {
    if (r.target === p.id && r.kind === 'dark') r.until = Math.min(r.until, now);
  }
}

export function isDarkNow(state, p, now = state.t) {
  return !!p.dark.since && (now - p.dark.since) > state.config.darkGraceS * S;
}

const opposing = (role) => (role === ROLE.GHOST ? ROLE.HUNTER : ROLE.GHOST);

// --------------------------------------------------------------- reveals --

function addReveal(state, r, now) {
  const reveal = {
    id: `r${state.nextId++}`,
    kind: r.kind,
    target: r.target ?? null,
    decoy: r.decoy ?? null,
    audience: r.audience,
    from: r.from ?? null,
    blur: r.blur ?? 0,
    heading: r.heading ?? null,
    live: !!r.live,
    lat: r.lat ?? null,
    lon: r.lon ?? null,
    until: r.until ?? now + 10 * S,
  };
  if (!reveal.live && reveal.lat == null && reveal.target) {
    const t = state.players[reveal.target];
    if (t) { reveal.lat = t.lat; reveal.lon = t.lon; }
  }
  state.reveals.push(reveal);
  return reveal;
}

/** Refresh a continuous reveal instead of stacking duplicates. */
function ensureReveal(state, r, now, ttl) {
  const existing = state.reveals.find(
    (x) => x.kind === r.kind && x.target === r.target && x.until > now,
  );
  if (existing) {
    existing.until = now + ttl;
    return existing;
  }
  return addReveal(state, { ...r, until: now + ttl }, now);
}

/** Reveals that exist only as a consequence of live gear (drones, dragnets). */
export function derivedReveals(state, now = state.t) {
  const out = [];
  for (const d of state.drones) {
    if (d.until <= now) continue;
    for (const g of located(ghosts(state))) {
      if (geo.distance(d, g) <= d.radius) {
        out.push({
          id: `d-${d.id}-${g.id}`, kind: 'drone', target: g.id, audience: ROLE.HUNTER,
          blur: 20, live: true, lat: g.lat, lon: g.lon, until: d.until, from: d.by,
        });
      }
    }
  }
  for (const h of located(hunters(state))) {
    if (h.fx.dragnet <= now) continue;
    for (const g of located(ghosts(state))) {
      if (g.fx.cloak > now) continue;
      if (geo.distance(h, g) <= 100) {
        out.push({
          id: `n-${h.id}-${g.id}`, kind: 'dragnet', target: g.id, audience: ROLE.HUNTER,
          blur: 15, live: true, lat: g.lat, lon: g.lon, until: h.fx.dragnet, from: h.id,
        });
      }
    }
  }
  return out;
}

// ----------------------------------------------------------------- pulse --

/**
 * Seconds until the next pulse — it ramps from `pingIntervalS` down to
 * `pingCollapseIntervalS` across the match, so the net tightens continuously
 * rather than snapping tighter at one arbitrary moment.
 */
export function pulseInterval(state, now = state.t) {
  const cfg = state.config;
  const span = Math.max(1, state.endsAt - state.startedAt);
  const p = Math.max(0, Math.min(1, (now - state.startedAt) / span));
  return cfg.pingIntervalS + (cfg.pingCollapseIntervalS - cfg.pingIntervalS) * p;
}

function pulse(state, now) {
  const cfg = state.config;
  const rng = mkRng(state);
  state.pulse.lastAt = now;
  state.pulse.nextAt = now + pulseInterval(state, now) * S;
  state.pulse.count += 1;

  for (const g of located(ghosts(state))) {
    if (g.convertAt > now) continue;
    if (g.fx.cloak > now) {
      log(state, { type: 'cloaked', who: g.id, audience: g.id });
      continue;
    }
    let blur = cfg.pingBlurM;
    let heading = null;
    if (g.speed < cfg.stillSpeedMs) {
      blur = cfg.pingBlurStillM;
    } else if (g.speed > cfg.movingSpeedMs) {
      // Running smears the fix, but a moving signal has a direction, and that
      // is what lets a hunter cut you off instead of chasing where you were.
      blur = cfg.pingBlurMovingM;
      heading = g.heading;
    }
    if (g.fx.static > now) { blur *= 3; g.fx.static = 0; }
    // Offset the blob so it is not helpfully centred on the ghost.
    const shown = geo.jitter({ lat: g.lat, lon: g.lon }, blur * 0.45, rng);
    addReveal(state, {
      kind: 'pulse', target: g.id, audience: ROLE.HUNTER, blur, heading,
      lat: shown.lat, lon: shown.lon, live: false, until: now + cfg.pingHoldS * S,
    }, now);
    g.pulsesSurvived += 1;
    g.score += cfg.scoreGhostPulse;
  }

  // Decoys look exactly like the real thing on a hunter's screen.
  for (const d of state.decoys) {
    if (d.until <= now || d.pulsesLeft === 0) continue;
    d.pulsesLeft = (d.pulsesLeft ?? 2) - 1;
    addReveal(state, {
      kind: 'pulse', target: null, decoy: d.id, audience: ROLE.HUNTER,
      blur: cfg.pingBlurM, lat: d.lat, lon: d.lon, live: false, until: now + cfg.pingHoldS * S,
    }, now);
  }
  log(state, { type: 'pulse', n: state.pulse.count, audience: 'all' });
}

// ------------------------------------------------------- world furniture --

function updateCaches(state, now, dt) {
  const rng = mkRng(state);
  const poly = zonePolygon(state);
  for (const c of state.caches) {
    if (c.takenBy && now >= c.respawnAt) {
      const p = geo.randomPointInPolygon(poly, rng);
      c.lat = p.lat; c.lon = p.lon; c.takenBy = null; c.respawnAt = 0;
    }
    // The collapse can strand a cache outside the zone: pull it back in.
    if (!c.takenBy && !geo.pointInPolygon(poly, c)) {
      const p = geo.randomPointInPolygon(poly, rng);
      c.lat = p.lat; c.lon = p.lon;
    }
  }
  for (const p of active(state)) {
    if (p.lat == null || p.convertAt > now) { p.collecting = null; continue; }
    const near = state.caches.find((c) => !c.takenBy && geo.distance(c, p) <= state.config.cacheCollectM);
    if (!near) { p.collecting = null; continue; }
    if (!p.collecting || p.collecting.id !== near.id) {
      p.collecting = { id: near.id, since: now };
    } else if (now - p.collecting.since >= state.config.cacheDwellS * S) {
      collect(state, p, near, now, rng);
      p.collecting = null;
    }
  }
}

function collect(state, p, cache, now, rng) {
  const cfg = state.config;
  cache.takenBy = p.id;
  cache.respawnAt = now + cfg.cacheRespawnS * S;
  p.caches += 1;
  p.charge = Math.min(cfg.chargeMax, p.charge + cfg.cacheCharge);
  p.score += p.role === ROLE.GHOST ? cfg.scoreCacheGhost : cfg.scoreCacheHunter;
  let item = null;
  if (p.items.length < cfg.inventorySize) {
    item = rollLoot(p.role, rng);
    if (item) p.items.push(item);
  } else {
    // Full hands: the cache converts to charge instead of being wasted.
    p.charge = Math.min(cfg.chargeMax, p.charge + 40);
  }
  log(state, { type: 'cache', who: p.id, item, audience: p.id });
}

function updateDecoys(state, now, dt) {
  for (const d of state.decoys) {
    if (d.until <= now) continue;
    const moved = geo.destination(d, d.drift, 0.6 * dt);
    d.lat = moved.lat; d.lon = moved.lon;
  }
  state.decoys = state.decoys.filter((d) => d.until > now && d.pulsesLeft !== 0);
}

function updateTraps(state, now) {
  for (const t of state.traps) {
    if (t.triggered || now < t.armedAt || now > t.until) continue;
    for (const p of located(active(state))) {
      if (p.id === t.by || p.role === t.role) continue;
      if (geo.distance(t, p) > 15) continue;
      t.triggered = true;
      if (t.role === ROLE.HUNTER) {
        addReveal(state, {
          kind: 'trap', target: p.id, audience: ROLE.HUNTER, blur: 10, live: true,
          until: now + 20 * S, from: t.by,
        }, now);
        log(state, { type: 'trapped', who: p.id, by: t.by, audience: 'all' });
      } else {
        p.fx.lockout = Math.max(p.fx.lockout, now + state.config.lockoutS * S);
        log(state, { type: 'fried', who: p.id, by: t.by, audience: 'all' });
      }
      break;
    }
  }
  state.traps = state.traps.filter((t) => !t.triggered && t.until > now);
}

function updateCatches(state, now) {
  const cfg = state.config;
  // The head start is a rule, not an honour system: nobody can be tagged
  // while the hunters are supposed to be standing still with their eyes shut.
  if (state.phase === PHASE.SCATTER) {
    for (const g of ghosts(state)) { g.taggedBy = null; g.taggedSince = 0; }
    return;
  }
  const hs = located(hunters(state)).filter((h) => h.convertAt === 0);
  const gs = located(ghosts(state)).filter((g) => g.convertAt === 0);
  for (const g of gs) {
    let holder = null;
    for (const h of hs) {
      const radius = h.fx.dragnet > now ? cfg.catchRadiusM * 2.25 : cfg.catchRadiusM;
      if (geo.distance(h, g) <= radius) { holder = h; break; }
    }
    if (!holder) { g.taggedBy = null; g.taggedSince = 0; continue; }
    if (g.taggedBy !== holder.id) {
      g.taggedBy = holder.id;
      g.taggedSince = now;
    } else if (now - g.taggedSince >= cfg.catchDwellS * S) {
      caught(state, g, holder, now);
    }
  }
}

function caught(state, ghost, hunter, now) {
  hunter.catches += 1;
  hunter.score += state.config.scoreCatch;
  ghost.caughtAt = now;
  ghost.caughtBy = hunter.id;
  ghost.taggedBy = null;
  ghost.items = [];
  ghost.fx = { cloak: 0, static: 0, scout: 0, bloodhound: 0, dragnet: 0, lockout: 0 };
  ghost.charge = state.config.chargeStart;
  if (state.config.infection) {
    ghost.role = ROLE.HUNTER;
    ghost.convertAt = now + state.config.convertS * S;
  } else {
    ghost.role = ROLE.SPECTATOR;
  }
  for (const r of state.reveals) if (r.target === ghost.id) r.until = now;
  log(state, { type: 'caught', who: ghost.id, by: hunter.id, audience: 'all' });
}

function prune(state, now) {
  state.reveals = state.reveals.filter((r) => r.until > now);
  state.drones = state.drones.filter((d) => d.until > now);
}

function checkEnd(state, now) {
  if (now >= state.endsAt) {
    finish(state, now, ghosts(state).length ? 'ghosts' : 'hunters');
    return;
  }
  if (state.startedAt && !ghosts(state).length) finish(state, now, 'hunters');
}

export { addReveal, finish };
