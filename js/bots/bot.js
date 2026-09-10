/**
 * Bot brains.
 *
 * These drive practice mode and the headless test matches. They deliberately
 * consume the *fog-of-war view* rather than the real state — the same object a
 * human's screen gets. So if a bot can play the game, the view contains enough
 * to play the game, and if a bot could cheat, so could a person with devtools.
 */

import * as geo from '../engine/geo.js';
import { ROLE } from '../engine/constants.js';

export function newBrain(id) {
  return {
    id, target: null, commitUntil: 0, flee: null, lastUse: 0, patience: 0,
    stamina: 1, alertAt: 0, jumpy: 0.75,
  };
}

/**
 * Bots tire. A person can sprint for well under a minute and then needs to walk
 * it off, and an evader who could run flat out forever would be uncatchable on
 * open ground — which would tell us nothing useful about the real game.
 */
function sprint(brain, dt) {
  if (brain.stamina < 0.25) return WALK;
  brain.stamina = Math.max(0, brain.stamina - dt / 45);
  return RUN;
}

const WALK = 1.45;   // m/s, an ordinary walking pace
const RUN = 3.1;

/**
 * @returns {{target:{lat:number,lon:number}|null, speed:number, use:{item:string,params?:object}|null}}
 */
export function decide(view, brain, rng, now, dt = 0.5) {
  if (!view || !view.me || view.me.lat == null) return { target: null, speed: 0, use: null };
  const me = view.me;
  brain.stamina = Math.min(1, brain.stamina + dt / 90);   // recover while walking
  const zone = view.zone.polygon;
  const centre = { lat: view.zone.lat, lon: view.zone.lon };
  // Pull the ring in by a fraction, so bots aim for open ground rather than
  // hugging a boundary they will be penalised for crossing. `f` is measured
  // per edge, as it was when this was a bounding box, so the numbers below
  // still mean what they meant when the balance was tuned against them.
  const inset = (f) => geo.scalePolygon(zone, Math.max(0.05, 1 - 2 * f), centre);

  // Anyone outside the shrinking zone has exactly one job.
  if (me.outsideM > 0) {
    brain.target = geo.randomPointInPolygon(inset(0.25), rng);
    brain.commitUntil = now + 20000;
    return { target: brain.target, speed: RUN, use: null };
  }

  const use = view.me.role === ROLE.HUNTER
    ? hunterItem(view, brain, rng, now)
    : ghostItem(view, brain, rng, now);

  let speed = WALK;
  let target = brain.target;

  // The head start: hunters wait at the start point, ghosts get gone.
  if (view.phase === 'scatter') {
    if (me.role === ROLE.HUNTER) {
      const home = view.start || centre;
      return { target: geo.distance(me, home) > 30 ? home : null, speed: WALK, use: null };
    }
    brain.stamina = 1;
    if (!brain.scatterTarget) {
      const from = view.start || centre;
      const away = geo.bearing(from, me) + (rng() - 0.5) * 120;
      const reach = (view.zone.sizeM / 2) * (0.55 + rng() * 0.4);
      const aim = geo.destination(from, away, reach);
      const playable = inset(0.06);
      // If that heading leaves the ground, take the nearest legal spot instead.
      brain.scatterTarget = geo.pointInPolygon(playable, aim)
        ? aim
        : (geo.nearestPointOnPolygon(playable, aim) || geo.randomPointInPolygon(playable, rng));
    }
    return { target: brain.scatterTarget, speed: sprint(brain, dt), use: ghostItem(view, brain, rng, now) };
  }

  if (view.me.role === ROLE.HUNTER) {
    // Head for the freshest thing anyone has seen.
    const lead = freshestReveal(view, now);
    if (lead) {
      // If the fix showed a heading, aim where they are going, not where they were.
      target = lead.heading != null
        ? geo.destination(lead, lead.heading, Math.min(400, lead.blur * 2 + 120))
        : { lat: lead.lat, lon: lead.lon };
      speed = sprint(brain, dt);
      brain.commitUntil = now + 8000;
    } else if (view.bearing) {
      target = geo.destination(me, view.bearing.deg, 150);
      speed = sprint(brain, dt);
      brain.commitUntil = now + 6000;
    } else if (view.proximity.level === 'near' || view.proximity.level === 'contact') {
      // Something is close but unseen: sweep tight circles rather than leave.
      if (now > brain.commitUntil) {
        brain.target = geo.destination(me, rng() * 360, 40);
        brain.commitUntil = now + 6000;
      }
      target = brain.target;
      speed = sprint(brain, dt);
    }
    // Eyes on a ghost: run them down.
    const seen = view.players.find((p) => p.role === ROLE.GHOST && p.lat != null);
    if (seen) {
      target = { lat: seen.lat, lon: seen.lon };
      speed = sprint(brain, dt);
      brain.commitUntil = now + 3000;
    }
  } else {
    // Ghost: bolt when something is breathing down your neck.
    const spooked = view.proximity.level === 'contact' || view.proximity.level === 'near';
    if (spooked && !brain.alertAt) {
      // Notice late, and not every time — people miss things.
      brain.alertAt = rng() < brain.jumpy ? now + 1500 + rng() * 3000 : Infinity;
    } else if (!spooked && Number.isFinite(brain.alertAt)) {
      brain.alertAt = 0;
    }
    if (spooked && now >= brain.alertAt) {
      if (!brain.flee || now > brain.flee.until) {
        const away = nearestHunterBearing(view, me);
        brain.flee = { deg: away == null ? rng() * 360 : (away + 180) % 360, until: now + 25000 };
      }
      target = geo.destination(me, brain.flee.deg, 200);
      brain.commitUntil = now + 4000;
      speed = sprint(brain, dt);
    } else if (now - (view.pulse.lastAt || 0) < 4000) {
      // Just been pinged — move, the blob is only as stale as you let it be.
      brain.target = geo.randomPointInPolygon(inset(0.1), rng);
      brain.commitUntil = now + 30000;
      target = brain.target;
      speed = RUN;
    }
  }

  // Otherwise: loot. Caches are the only reason to cross open ground, and the
  // item matters more than the charge — full hands are what make you dangerous.
  const wantsLoot = me.items.length < view.config.inventorySize ||
    me.charge < view.config.chargeMax * 0.75;
  if (view.caches.length && wantsLoot) {
    let best = null; let bestD = Infinity;
    for (const c of view.caches) {
      const d = geo.distance(me, c);
      if (d < bestD) { bestD = d; best = c; }
    }
    // Standing on one: hold still until the dwell timer pops.
    if (best && bestD <= view.config.cacheCollectM) {
      return { target: null, speed: 0, use };
    }
    if (best && bestD < 320 && (!target || now > brain.commitUntil || fleeing(brain, now) === false)) {
      target = { lat: best.lat, lon: best.lon };
      brain.target = target;
      brain.commitUntil = now + 45000;
    }
  }

  if (!target || now > brain.commitUntil) {
    brain.target = geo.randomPointInPolygon(inset(view.me.role === ROLE.GHOST ? 0.08 : 0.02), rng);
    brain.commitUntil = now + 60000;
    target = brain.target;
  }

  // Arrived? Idle a beat before choosing somewhere new.
  if (geo.distance(me, target) < 4) {
    brain.commitUntil = 0;
    speed = 0;
  }
  return { target, speed, use };
}

const fleeing = (brain, now) => !!(brain.flee && now < brain.flee.until);

function freshestReveal(view, now) {
  let best = null;
  for (const r of view.reveals) {
    if (r.lat == null) continue;
    if (!['pulse', 'sonar', 'drone', 'dark', 'flag', 'oob', 'trap', 'dragnet'].includes(r.kind)) continue;
    if (!best || r.until > best.until) best = r;
  }
  return best;
}

function nearestHunterBearing(view, me) {
  let best = null; let bestD = Infinity;
  for (const p of view.players) {
    if (p.role !== ROLE.HUNTER || p.lat == null) continue;
    const d = geo.distance(me, p);
    if (d < bestD) { bestD = d; best = p; }
  }
  for (const r of view.reveals) {
    if (r.lat == null || r.kind !== 'scout') continue;
    const d = geo.distance(me, r);
    if (d < bestD) { bestD = d; best = r; }
  }
  return best ? geo.bearing(me, best) : null;
}

function has(me, item) { return me.items.includes(item); }
function affordable(view, item, cost) { return view.me.charge >= cost; }

function ghostItem(view, brain, rng, now) {
  const me = view.me;
  if (me.fx.lockout > now) return null;
  const untilPulse = (view.pulse.nextAt || Infinity) - now;
  if (me.dark.flaggedUntil > now && has(me, 'blink')) return { item: 'blink' };
  if (has(me, 'cloak') && untilPulse < 12000 && affordable(view, 'cloak', 60)) return { item: 'cloak' };
  if (has(me, 'static') && untilPulse < 20000 && affordable(view, 'static', 35)) return { item: 'static' };
  if (has(me, 'scout') && view.proximity.level !== 'none' && affordable(view, 'scout', 50)) return { item: 'scout' };
  if (has(me, 'decoy') && untilPulse < 30000 && affordable(view, 'decoy', 45)) return { item: 'decoy' };
  if (has(me, 'overcharge') && me.charge < 70) return { item: 'overcharge' };
  if (has(me, 'trap') && view.proximity.level === 'near' && affordable(view, 'trap', 40)) return { item: 'trap' };
  return null;
}

function hunterItem(view, brain, rng, now) {
  const me = view.me;
  if (me.fx.lockout > now || me.convertAt > now) return null;
  const blind = !view.reveals.some((r) => r.until > now + 2000);
  if (has(me, 'overcharge') && me.charge < 70) return { item: 'overcharge' };
  if (has(me, 'dragnet') && view.proximity.level !== 'none' && affordable(view, 'dragnet', 60)) return { item: 'dragnet' };
  if (has(me, 'sonar') && blind && affordable(view, 'sonar', 55)) return { item: 'sonar' };
  if (has(me, 'bloodhound') && blind && !view.bearing && affordable(view, 'bloodhound', 60)) return { item: 'bloodhound' };
  if (has(me, 'drone') && blind && affordable(view, 'drone', 55)) {
    const at = geo.destination(me, rng() * 360, 200 + rng() * 400);
    return { item: 'drone', params: { lat: at.lat, lon: at.lon } };
  }
  if (has(me, 'trap') && view.caches.length && affordable(view, 'trap', 40)) return { item: 'trap' };
  return null;
}

/** Move a point toward a target at `speed` for `dt` seconds, with a little noise. */
export function walk(from, target, speed, dt, rng, jitterM = 0.6) {
  if (!target || speed <= 0) return from;
  const d = geo.distance(from, target);
  const stepM = Math.min(d, speed * dt);
  if (stepM <= 0) return from;
  const brg = geo.bearing(from, target) + (rng() - 0.5) * 12;
  const next = geo.destination(from, brg, stepM);
  return jitterM ? geo.jitter(next, jitterM, rng) : next;
}
