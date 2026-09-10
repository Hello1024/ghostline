/**
 * Headless match runner.
 *
 * Spins up a full game of bots, drives it tick by tick through the real
 * engine and the real fog-of-war view, and returns the finished state plus a
 * trace. Used by the integration tests and handy for balance tinkering:
 *
 *   node test/harness.mjs --players 7 --hunters 2 --minutes 30 --seed 42
 */

import { createGame, addPlayer, assignRoles, log } from '../js/engine/state.js';
import { applyIntent, step } from '../js/engine/engine.js';
import { viewFor, leaderboard } from '../js/engine/view.js';
import { mkRng } from '../js/engine/rng.js';
import { newBrain, decide, walk } from '../js/bots/bot.js';
import * as geo from '../js/engine/geo.js';
import { ROLE } from '../js/engine/constants.js';

/**
 * @param {object} opts
 * @param {number} [opts.players] roster size
 * @param {number} [opts.hunters] starting seekers
 * @param {number} [opts.minutes] match length
 * @param {Array}  [opts.darkPlan] [{player, atS, forS, moveM}] scripted blackouts.
 *                 `moveM` > 0 means they physically move while dark (the cheat).
 * @param {Function} [opts.onTick] observer(state, now)
 */
export function runMatch(opts = {}) {
  const {
    players = 7, hunters = 2, minutes = 30, seed = 'harness',
    tickHz = 2, area = { lat: 51.5074, lon: -0.1278 }, config = {},
    darkPlan = [], onTick = null, startSpreadM = 60,
  } = opts;

  const t0 = 1_700_000_000_000;
  const state = createGame({
    seed, area, now: t0, hostId: 'p0', code: 'TEST',
    config: { durationS: minutes * 60, ...config },
  });
  const rng = mkRng({ rngState: 0xC0FFEE }, 'rngState');

  for (let i = 0; i < players; i++) {
    addPlayer(state, { id: `p${i}`, name: `Bot${i}` });
  }
  assignRoles(state, hunters);

  const brains = {};
  const pos = {};
  const startPoint = { ...area };
  for (const p of Object.values(state.players)) {
    brains[p.id] = newBrain(p.id);
    pos[p.id] = geo.jitter(startPoint, startSpreadM, rng);
    applyIntent(state, p.id, { type: 'fix', ...pos[p.id], acc: 8, at: t0 }, t0);
    applyIntent(state, p.id, { type: 'presence', visible: true, wakeLock: true }, t0);
  }
  applyIntent(state, 'p0', { type: 'start', start: startPoint }, t0);

  const dtMs = 1000 / tickHz;
  const endAt = state.endsAt + 2000;
  const trace = { pulses: 0, catches: 0, cachesTaken: 0, flags: 0, itemsUsed: 0, darkSeconds: 0, byItem: {}, errors: [] };
  const dark = new Map();               // playerId -> {until, moveM, mark}
  const plan = darkPlan.map((d) => ({ ...d, fired: false }));

  let now = t0;
  let guard = 0;
  while (now < endAt && state.phase !== 'over') {
    if (++guard > 400000) throw new Error('harness runaway');
    now += dtMs;
    const elapsedS = (now - t0) / 1000;
    const before = state.feed.length ? state.feed[state.feed.length - 1].id : -1;

    for (const entry of plan) {
      if (!entry.fired && elapsedS >= entry.atS) {
        entry.fired = true;
        dark.set(entry.player, { until: now + entry.forS * 1000, totalMs: entry.forS * 1000, moveM: entry.moveM || 0, mark: { ...pos[entry.player] } });
      }
    }

    for (const p of Object.values(state.players)) {
      const d = dark.get(p.id);
      if (d) {
        if (now >= d.until) {
          // Wake up: report the screen is back, then the new position.
          dark.delete(p.id);
          applyIntent(state, p.id, { type: 'presence', visible: true, wakeLock: true }, now);
          applyIntent(state, p.id, { type: 'fix', ...pos[p.id], acc: 8, at: now }, now);
        } else {
          // Dark: the client says nothing at all. That silence is the signal the
          // host reads — it does not depend on a cheating client being honest.
          // `moveM` is ground covered over the blackout, spread evenly.
          if (d.moveM > 0) {
            const perTick = d.moveM / Math.max(1, d.totalMs / dtMs);
            pos[p.id] = geo.destination(pos[p.id], 45, perTick);
          }
          continue;
        }
      }

      const view = viewFor(state, p.id, now);
      const plan2 = decide(view, brains[p.id], rng, now, dtMs / 1000);
      if (plan2.use) {
        const r = applyIntent(state, p.id, { type: 'use', item: plan2.use.item, params: plan2.use.params }, now);
        if (r.ok) trace.itemsUsed++;
        else if (!['not-enough-charge', 'not-held', 'locked-out', 'not-running', 'converting'].includes(r.error)) {
          trace.errors.push(r.error);
        }
      }
      pos[p.id] = walk(pos[p.id], plan2.target, plan2.speed, dtMs / 1000, rng);
      const r = applyIntent(state, p.id, { type: 'fix', ...pos[p.id], acc: 6 + rng() * 8, at: now }, now);
      if (!r.ok) trace.errors.push(r.error);
    }

    // Anyone scripted dark stops talking entirely — that silence is the signal.
    for (const [id, d] of dark) {
      if (d.moveM > 0) { /* movement already applied above */ }
    }

    step(state, now);
    for (const e of state.feed) {
      if (e.id <= before) continue;
      if (e.type === 'pulse') trace.pulses++;
      if (e.type === 'caught') trace.catches++;
      if (e.type === 'cache') trace.cachesTaken++;
      if (e.type === 'flag') trace.flags++;
      if (e.type === 'use') trace.byItem[e.item] = (trace.byItem[e.item] || 0) + 1;
    }
    if (onTick) onTick(state, now);
  }

  trace.darkSeconds = Object.values(state.players).reduce((a, p) => a + p.dark.totalMs / 1000, 0);
  return { state, trace, board: leaderboard(state), pos, t0, now };
}

// --- CLI ------------------------------------------------------------------
const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const arg = (k, d) => {
    const i = process.argv.indexOf(`--${k}`);
    return i > -1 ? process.argv[i + 1] : d;
  };
  const t = Date.now();
  const { state, trace, board } = runMatch({
    players: +arg('players', 7),
    hunters: +arg('hunters', 2),
    minutes: +arg('minutes', 30),
    seed: arg('seed', 'harness'),
    darkPlan: arg('dark') ? [{ player: 'p3', atS: 300, forS: 120, moveM: 300 }] : [],
  });
  console.log(`match over in ${Date.now() - t}ms  outcome=${state.outcome}  phase=${state.phase}`);
  console.log('trace', trace);
  console.table(board.map((b) => ({
    name: b.name, role: b.role, score: b.score, catches: b.catches,
    caches: b.caches, km: (b.distanceM / 1000).toFixed(2), pulses: b.pulsesSurvived,
    darkS: b.darkS, jumps: b.jumps,
  })));
}
