/**
 * Hostile input. Every message reaching the host came off the network from a
 * device we do not control, so the engine has to survive nonsense without
 * throwing, corrupting the world, or handing anyone an advantage.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyIntent, step } from '../js/engine/engine.js';
import { viewFor } from '../js/engine/view.js';
import { ITEM_IDS } from '../js/engine/items.js';
import { mkRng } from '../js/engine/rng.js';
import { makeGame, place, start, checkInvariants, T0 } from './_util.mjs';

const JUNK = [
  undefined, null, 0, '', [], {}, { type: '' }, { type: 'fix' },
  { type: 'fix', lat: NaN, lon: NaN }, { type: 'fix', lat: Infinity, lon: 0 },
  { type: 'fix', lat: '51.5', lon: '-0.12' }, { type: 'fix', lat: 1e9, lon: -1e9 },
  { type: 'use' }, { type: 'use', item: '__proto__' }, { type: 'use', item: 'constructor' },
  { type: 'use', item: 'drone', params: { lat: 'x', lon: null } },
  { type: 'presence' }, { type: 'name', value: 'x'.repeat(5000) },
  { type: 'setRole', target: 'nobody', role: 'god' },
  { type: 'config', config: { catchRadiusM: 1e9, durationS: -5, cacheCount: 1e6, infection: 'yes' } },
  { type: 'area', lat: 'north', lon: {} },
  { type: '__proto__' }, { type: 'toString' },
];

test('random hostile intents never throw and never break an invariant', () => {
  const rng = mkRng({ rngState: 20260910 });
  const ids = ['h1', 'h2', 'g1', 'g2', 'g3'];
  const s = makeGame({
    players: ids, roles: { h1: 'hunter', h2: 'hunter' },
    config: { scatterS: 10, durationS: 900, cacheCount: 10 },
  });
  start(s);
  let now = T0;
  for (const id of ids) place(s, id, rng.range(-400, 400), rng.range(-400, 400));

  for (let i = 0; i < 20000; i++) {
    now += rng.int(400);
    const who = rng.bool(0.1) ? `stranger${rng.int(5)}` : rng.pick(ids);
    let intent;
    if (rng.bool(0.35)) {
      intent = rng.pick(JUNK);
    } else if (rng.bool(0.5)) {
      intent = { type: 'fix', lat: 51.5074 + rng.range(-0.02, 0.02), lon: -0.1278 + rng.range(-0.03, 0.03), acc: rng.range(0, 300), at: now };
    } else if (rng.bool(0.5)) {
      intent = { type: 'use', item: rng.pick(ITEM_IDS), params: { lat: 51.5 + rng.range(-1, 1), lon: -0.12 } };
    } else {
      intent = { type: 'presence', visible: rng.bool(), wakeLock: rng.bool() };
    }
    let result;
    assert.doesNotThrow(() => { result = applyIntent(s, who, intent, now); }, `intent ${JSON.stringify(intent)}`);
    assert.equal(typeof result?.ok, 'boolean');
    assert.doesNotThrow(() => step(s, now));
    if (i % 250 === 0) {
      const problems = checkInvariants(s, `iteration ${i}`);
      assert.deepEqual(problems, [], problems.join('\n'));
    }
  }
  assert.deepEqual(checkInvariants(s, 'final'), []);
});

test('a hostile config patch cannot escape its bounds', () => {
  const s = makeGame({ config: { scatterS: 10 } });
  applyIntent(s, 'h1', {
    type: 'config',
    config: { catchRadiusM: 1e9, cacheCount: -50, durationS: 1e12, areaSizeM: 1e9, junk: 1, __proto__: { evil: true } },
  }, T0);
  assert.ok(s.config.catchRadiusM <= 60, `catch radius ${s.config.catchRadiusM}`);
  assert.ok(s.config.cacheCount >= 0, `cache count ${s.config.cacheCount}`);
  assert.ok(s.config.durationS <= 120 * 60);
  assert.ok(s.config.areaSizeM <= 4000);
  assert.equal(s.config.junk, undefined, 'an unknown key got through');
  assert.equal({}.evil, undefined, 'prototype pollution');
  // Internal balance dials are not reachable from the wire at all.
  applyIntent(s, 'h1', { type: 'config', config: { chargePerMetre: 1000, maxSpeedMs: 1e9 } }, T0);
  assert.equal(s.config.chargePerMetre, 0.35);
  assert.equal(s.config.maxSpeedMs, 12);
});

test('an area sent over the wire is clamped to a playable size', () => {
  const s = makeGame();
  applyIntent(s, 'h1', { type: 'area', lat: 51.5, lon: -0.1, sizeM: 1e7 }, T0);
  // sizeM is derived from the polygon's true area, so a square comes back a
  // few centimetres under its nominal side. Compare with that in mind.
  assert.ok(s.area.sizeM <= 4001, `area ${s.area.sizeM}`);
  assert.ok(s.area.sizeM > 3990, `area ${s.area.sizeM}`);
  applyIntent(s, 'h1', { type: 'area', lat: 51.5, lon: -0.1, sizeM: 1 }, T0);
  assert.ok(s.area.sizeM >= 399, `area ${s.area.sizeM}`);
  assert.equal(s.area.polygon.length, 4);
});

test('a player cannot spend an item they do not hold, however hard they try', () => {
  const s = makeGame({ config: { scatterS: 0 } });
  start(s);
  place(s, 'g1', 0, 0);
  s.players.g1.charge = 200;
  for (let i = 0; i < 500; i++) {
    const r = applyIntent(s, 'g1', { type: 'use', item: 'cloak' }, s.t);
    assert.equal(r.ok, false);
  }
  assert.equal(s.players.g1.charge, 200, 'charge was spent on nothing');
  assert.equal(s.players.g1.fx.cloak, 0);
});

test('views survive a fuzzed world', () => {
  const rng = mkRng({ rngState: 77 });
  const ids = ['h1', 'g1', 'g2'];
  const s = makeGame({ players: ids, roles: { h1: 'hunter' }, config: { scatterS: 0 } });
  start(s);
  let now = T0;
  for (let i = 0; i < 3000; i++) {
    now += 250;
    applyIntent(s, rng.pick(ids), rng.pick(JUNK), now);
    applyIntent(s, rng.pick(ids), { type: 'fix', lat: 51.5074 + rng.range(-0.01, 0.01), lon: -0.1278 + rng.range(-0.01, 0.01), acc: 5, at: now }, now);
    step(s, now);
    for (const id of ids) {
      const v = viewFor(s, id, now);
      assert.ok(v && v.me && Array.isArray(v.players) && Array.isArray(v.reveals));
      assert.doesNotThrow(() => JSON.stringify(v));
    }
  }
  assert.equal(viewFor(s, 'nobody', now), null);
});
