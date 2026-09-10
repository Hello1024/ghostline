/**
 * Whole matches, played by bots through the real engine and the real
 * fog-of-war view. These are the tests that would notice the game becoming
 * unplayable — a phase that never arrives, an economy that never starts, a
 * side that can no longer win.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { runMatch } from './harness.mjs';
import { viewFor } from '../js/engine/view.js';
import * as geo from '../js/engine/geo.js';
import { checkInvariants } from './_util.mjs';

test('a seven-player match plays to the whistle without complaint', () => {
  const problems = [];
  const { state, trace, board } = runMatch({
    seed: 'integration', players: 7, hunters: 2, minutes: 30,
    onTick: (s, now) => {
      if (Math.round(now / 500) % 60 === 0) problems.push(...checkInvariants(s, `t=${now}`));
    },
  });
  assert.deepEqual(problems.slice(0, 5), []);
  assert.deepEqual(trace.errors.slice(0, 5), [], 'the engine rejected a legitimate intent');
  assert.equal(state.phase, 'over');
  assert.ok(['ghosts', 'hunters'].includes(state.outcome));
  assert.equal(board.length, 7);
  assert.ok(board.every((row) => Number.isFinite(row.score)));
});

test('every phase actually happens, in order', () => {
  const seen = [];
  runMatch({
    seed: 'phases', minutes: 20,
    onTick: (s) => { if (seen[seen.length - 1] !== s.phase) seen.push(s.phase); },
  });
  assert.deepEqual(seen, ['scatter', 'hunt', 'collapse', 'over']);
});

test('the field spreads out during the head start', () => {
  let atStart = null;
  let atHunt = null;
  runMatch({
    seed: 'spread', minutes: 20,
    onTick: (s, now) => {
      const spread = () => {
        const ps = Object.values(s.players).filter((p) => p.lat != null);
        let max = 0;
        for (const a of ps) for (const b of ps) max = Math.max(max, geo.distance(a, b));
        return max;
      };
      if (atStart == null && s.phase === 'scatter') atStart = spread();
      if (atHunt == null && s.phase === 'hunt') atHunt = spread();
    },
  });
  assert.ok(atHunt > atStart * 2, `spread went ${atStart?.toFixed(0)}m -> ${atHunt?.toFixed(0)}m`);
  assert.ok(atHunt > 300, `field only spread ${atHunt?.toFixed(0)}m`);
});

test('the loot economy runs: caches are opened and abilities are played', () => {
  const { trace } = runMatch({ seed: 'economy', minutes: 30 });
  assert.ok(trace.cachesTaken > 10, `only ${trace.cachesTaken} caches opened`);
  assert.ok(trace.itemsUsed > 5, `only ${trace.itemsUsed} abilities used`);
  const kinds = Object.keys(trace.byItem);
  assert.ok(kinds.length >= 5, `only ${kinds.length} distinct abilities ever fired: ${kinds}`);
});

test('the pulse keeps firing and speeds up as the clock runs down', () => {
  const gaps = [];
  let last = 0;
  runMatch({
    seed: 'pulses', minutes: 30,
    onTick: (s) => {
      if (s.pulse.lastAt && s.pulse.lastAt !== last) {
        if (last) gaps.push((s.pulse.lastAt - last) / 1000);
        last = s.pulse.lastAt;
      }
    },
  });
  assert.ok(gaps.length > 8, `only ${gaps.length} pulses`);
  const first = gaps[0];
  const final = gaps[gaps.length - 1];
  assert.ok(final < first * 0.75, `pulse interval went ${first}s -> ${final}s`);
});

test('the zone really does close in', () => {
  let widest = 0;
  let narrowest = Infinity;
  const { state } = runMatch({
    seed: 'zone', minutes: 30,
    onTick: (s) => {
      widest = Math.max(widest, s.zone.sizeM);
      narrowest = Math.min(narrowest, s.zone.sizeM);
    },
  });
  assert.ok(narrowest < widest * 0.5, `zone went ${widest} -> ${narrowest}`);
  assert.ok(narrowest >= state.config.areaSizeM * state.config.zoneShrinkTo - 1);
});

test('neither side is hopeless across a run of matches', () => {
  // Bots are poor hiders and worse searchers, so this is a floor, not a
  // forecast — but if one side stops winning entirely, something has broken.
  let ghostWins = 0;
  let catches = 0;
  const runs = 12;
  for (let i = 0; i < runs; i++) {
    const { state } = runMatch({ seed: `fair-${i}`, minutes: 30, players: 7, hunters: 2 });
    if (state.outcome === 'ghosts') ghostWins++;
    catches += Object.values(state.players).filter((p) => p.caughtAt).length;
  }
  assert.ok(catches >= runs, `only ${catches} catches across ${runs} matches`);
  assert.ok(ghostWins > 0, 'ghosts never survive');
  assert.ok(catches / runs < 5, `hunters swept every match (${catches / runs} catches each)`);
});

test('no hunter is ever handed a hidden ghost position, at any point in a match', () => {
  let leaked = null;
  runMatch({
    seed: 'noleak', minutes: 20,
    onTick: (s, now) => {
      // After the whistle every position is public, by design.
      if (leaked || s.phase === 'over' || Math.round(now / 500) % 40 !== 0) return;
      for (const h of Object.values(s.players)) {
        if (h.role !== 'hunter' || h.lat == null) continue;
        const view = viewFor(s, h.id, now);
        const rows = view.players.filter((r) => r.role === 'ghost' && r.lat != null);
        for (const row of rows) {
          const real = s.players[row.id];
          // The only legitimate reason to be handed a live ghost position is
          // that they are close enough to see with your own eyes.
          if (geo.distance(h, real) > 36) leaked = `${h.id} could see ${row.id} at ${Math.round(geo.distance(h, real))}m`;
        }
      }
    },
  });
  assert.equal(leaked, null);
});

test('blackouts are recorded, and only real jumps are flagged', () => {
  const { state, trace } = runMatch({
    seed: 'dark', minutes: 30,
    darkPlan: [
      { player: 'p1', atS: 400, forS: 5, moveM: 0 },      // a glance
      { player: 'p2', atS: 500, forS: 180, moveM: 120 },  // away, but honest
      { player: 'p3', atS: 600, forS: 120, moveM: 600 },  // away, in a car
    ],
  });
  assert.equal(state.players.p1.dark.totalMs, 0, 'a five-second glance was penalised');
  assert.ok(state.players.p2.dark.totalMs > 150_000, 'a three-minute blackout went unrecorded');
  assert.equal(state.players.p2.dark.jumps, 0, 'an honest player was flagged');
  assert.equal(state.players.p3.dark.jumps, 1, 'a 600m jump was not flagged');
  assert.ok(trace.flags >= 1);
});

test('a bigger field and a bigger crowd still finishes cleanly', () => {
  const { state, trace } = runMatch({
    seed: 'big', players: 12, hunters: 3, minutes: 45,
    config: { areaSizeM: 2400 },
  });
  assert.equal(state.phase, 'over');
  assert.deepEqual(trace.errors.slice(0, 3), []);
  assert.deepEqual(checkInvariants(state, 'big'), []);
});

test('a two-player match is legal and finishes', () => {
  const { state } = runMatch({ seed: 'duel', players: 2, hunters: 1, minutes: 10 });
  assert.equal(state.phase, 'over');
});
