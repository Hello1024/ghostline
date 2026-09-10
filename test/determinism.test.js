/**
 * The engine must be reproducible: same seed, same inputs, same world. That is
 * what lets the host be authoritative and lets a disputed match be replayed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { runMatch } from './harness.mjs';
import { applyIntent, step } from '../js/engine/engine.js';
import { createGame, addPlayer, assignRoles, spawnCaches } from '../js/engine/state.js';
import { mkRng } from '../js/engine/rng.js';
import { fingerprint, makeGame, place, start, run, heartbeat, T0 } from './_util.mjs';

test('two matches with the same seed are identical', () => {
  const a = runMatch({ seed: 'same', minutes: 12 });
  const b = runMatch({ seed: 'same', minutes: 12 });
  assert.equal(fingerprint(a.state), fingerprint(b.state));
  assert.deepEqual(a.board, b.board);
});

test('a different seed gives a different match', () => {
  const a = runMatch({ seed: 'one', minutes: 12 });
  const b = runMatch({ seed: 'two', minutes: 12 });
  assert.notEqual(fingerprint(a.state), fingerprint(b.state));
});

test('replaying a recorded intent log reproduces the world exactly', () => {
  const build = () => {
    const s = createGame({
      seed: 'replay', area: { lat: 51.5074, lon: -0.1278 }, now: T0,
      hostId: 'p0', code: 'RPLY', config: { durationS: 600, scatterS: 30, cacheCount: 6 },
    });
    for (const id of ['p0', 'p1', 'p2', 'p3']) addPlayer(s, { id, name: id });
    assignRoles(s, 1);
    return s;
  };

  // Record a session.
  const live = build();
  const rng = mkRng({ rngState: 4242 });
  const log = [];
  const record = (id, intent, at) => { log.push({ id, intent, at }); applyIntent(live, id, intent, at); };
  record('p0', { type: 'start' }, T0);
  let now = T0;
  for (let i = 0; i < 600; i++) {
    now += 1000;
    for (const id of Object.keys(live.players)) {
      record(id, {
        type: 'fix',
        lat: 51.5074 + (rng() - 0.5) * 0.004,
        lon: -0.1278 + (rng() - 0.5) * 0.006,
        acc: 5, at: now,
      }, now);
    }
    step(live, now);
  }

  // Replay it into a fresh world.
  const replay = build();
  let cursor = 0;
  let t = T0;
  applyIntent(replay, log[0].id, log[0].intent, log[0].at);
  cursor = 1;
  for (let i = 0; i < 600; i++) {
    t += 1000;
    while (cursor < log.length && log[cursor].at <= t) {
      applyIntent(replay, log[cursor].id, log[cursor].intent, log[cursor].at);
      cursor++;
    }
    step(replay, t);
  }
  assert.equal(fingerprint(replay), fingerprint(live));
});

test('the generator state travels with the world, so a resumed match agrees', () => {
  const s = makeGame({ config: { scatterS: 0, cacheCount: 8 } });
  start(s);
  place(s, 'h1', 0, 0); place(s, 'g1', 400, 0);
  run(s, 20_000, { each: (now) => heartbeat(s, now) });
  // Serialise mid-match, as the host would when a peer reconnects.
  const frozen = JSON.parse(JSON.stringify(s));
  const a = run(s, 60_000, { each: (now) => heartbeat(s, now) });
  const b = run(frozen, 60_000, { each: (now) => heartbeat(frozen, now) });
  assert.equal(a, b);
  assert.equal(fingerprint(frozen), fingerprint(s), 'a resumed match diverged');
});
