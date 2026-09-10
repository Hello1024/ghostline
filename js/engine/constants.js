/**
 * GHOSTLINE — tuning constants.
 *
 * Every value here is a game-design dial. The lobby host can override the
 * subset listed in `CONFIG_SCHEMA`; everything else is fixed balance.
 *
 * Units: metres, seconds (suffix `S`) or milliseconds (suffix `Ms`).
 */

export const VERSION = 1;

/** Default match configuration. Overridable keys are in CONFIG_SCHEMA. */
export const DEFAULT_CONFIG = Object.freeze({
  // --- shape of the match -------------------------------------------------
  durationS: 30 * 60,      // total match length
  scatterS: 3 * 60,        // hunters are held at the start point
  collapseS: 8 * 60,       // final phase: zone shrinks, pulses speed up
  areaSizeM: 1609,         // side of the square play area (1 mile)
  hunterCount: 2,          // suggested seekers at start (host can override)
  infection: true,         // caught ghosts become hunters (else spectate)

  // --- the pulse: the heartbeat of the game -------------------------------
  // The pulse accelerates smoothly across the match, from `pingIntervalS` at
  // the whistle to `pingCollapseIntervalS` at the death. Nothing about the
  // endgame needs explaining: you can feel it speeding up.
  pingIntervalS: 135,      // ghosts are revealed to hunters this often, at first
  pingCollapseIntervalS: 45,
  pingHoldS: 10,           // how long a pulse blob stays on screen
  // A stationary transmitter is easy to triangulate; a moving one smears. So
  // the pulse punishes camping and the whole match gets up and walks every two
  // minutes — which is the point of playing this outdoors.
  pingBlurM: 75,           // walking: the ordinary blob
  pingBlurStillM: 35,      // sitting still: a tight, damning fix
  pingBlurMovingM: 130,    // running: a wide smear — but it shows your heading
  stillSpeedMs: 0.4,       // below this you count as stationary
  movingSpeedMs: 1.8,      // above this you count as running

  // --- catching -----------------------------------------------------------
  catchRadiusM: 20,
  catchDwellS: 3,          // hunter must hold the tag for this long
  proximityWarnM: 60,      // hunters feel a heartbeat this close to a ghost
  convertS: 30,            // caught ghost is frozen before joining the hunt

  // --- loot ---------------------------------------------------------------
  cacheCount: 18,          // live caches in the field at once
  cacheVisibleM: 300,      // you can see a cache from this far
  cacheCollectM: 12,
  cacheDwellS: 2,          // stand still on it to open it
  cacheRespawnS: 90,
  cacheCharge: 25,

  // --- charge (the ability currency, earned by walking) --------------------
  chargeMax: 200,
  chargeStart: 60,
  chargePerMetre: 0.35,
  inventorySize: 3,

  // --- blackout: the anti-pocket rule -------------------------------------
  darkGraceS: 8,           // free window for a glance at a notification
  darkDrainPerS: 3,        // charge burned per second in the dark
  darkWalkSpeedMs: 2.2,    // movement we consider "explainable" while dark
  darkSlackM: 30,          // GPS drift allowance on top of that
  ghostFlagS: 30,          // punishment reveal after an unexplained jump
  lockoutS: 25,            // no abilities while locked out

  // --- out of bounds ------------------------------------------------------
  oobGraceS: 20,
  oobDrainPerS: 2,
  zoneShrinkTo: 0.30,      // collapse shrinks the square to this fraction

  // --- scoring ------------------------------------------------------------
  scoreGhostPerS: 1,
  scoreGhostSurvive: 250,
  scoreGhostPulse: 20,     // per pulse survived
  scoreCacheGhost: 50,
  scoreCacheHunter: 25,
  scoreCatch: 300,
  scoreSweepPerMinLeft: 20,

  // --- sanity -------------------------------------------------------------
  maxPlayers: 12,
  maxSpeedMs: 12,          // faster than this is a vehicle or a spoof
  maxAccuracyM: 50,        // fixes worse than this earn no charge
  fixTimeoutS: 12,         // no fix for this long counts as going dark
});

/** Host-editable settings, with bounds the UI and the validator both use. */
export const CONFIG_SCHEMA = Object.freeze({
  durationS:      { min: 5 * 60, max: 120 * 60, step: 60,  label: 'Match length' },
  scatterS:       { min: 0,      max: 10 * 60,  step: 30,  label: 'Scatter time' },
  collapseS:      { min: 0,      max: 20 * 60,  step: 60,  label: 'Collapse phase' },
  areaSizeM:      { min: 400,    max: 4000,     step: 100, label: 'Play area' },
  pingIntervalS:  { min: 30,     max: 600,      step: 15,  label: 'Pulse interval' },
  catchRadiusM:   { min: 10,     max: 60,       step: 5,   label: 'Catch radius' },
  cacheCount:     { min: 0,      max: 40,       step: 1,   label: 'Caches' },
  infection:      { type: 'bool',                          label: 'Caught players join the hunt' },
});

export const ROLE = Object.freeze({
  GHOST: 'ghost',
  HUNTER: 'hunter',
  SPECTATOR: 'spectator',
});

export const PHASE = Object.freeze({
  LOBBY: 'lobby',
  SCATTER: 'scatter',
  HUNT: 'hunt',
  COLLAPSE: 'collapse',
  OVER: 'over',
});

/**
 * Build a config from a *trusted* source — our own code, a test, a saved
 * preset. Any key that exists in DEFAULT_CONFIG may be set, so every balance
 * dial is reachable, but nothing outside it is.
 */
export function normaliseConfig(partial = {}) {
  const cfg = { ...DEFAULT_CONFIG };
  for (const [key, raw] of Object.entries(partial || {})) {
    if (!(key in DEFAULT_CONFIG) || raw == null) continue;
    if (typeof DEFAULT_CONFIG[key] === 'boolean') {
      cfg[key] = !!raw;
      continue;
    }
    const n = Number(raw);
    if (Number.isFinite(n)) cfg[key] = n;
  }
  // The collapse phase can never outlast the match minus the head start.
  cfg.collapseS = Math.min(cfg.collapseS, Math.max(0, cfg.durationS - cfg.scatterS));
  return cfg;
}

/**
 * Sanitise settings arriving over the wire from the host's device. Only the
 * dials the lobby UI actually exposes get through, each clamped to its own
 * bounds — a peer cannot hand us a 100km catch radius or a negative timer.
 */
export function hostConfigPatch(partial = {}) {
  const out = {};
  for (const [key, spec] of Object.entries(CONFIG_SCHEMA)) {
    const raw = partial?.[key];
    if (raw == null) continue;
    if (spec.type === 'bool') { out[key] = !!raw; continue; }
    const n = Number(raw);
    if (!Number.isFinite(n)) continue;
    out[key] = Math.min(spec.max, Math.max(spec.min, n));
  }
  return out;
}
