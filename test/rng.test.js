import test from 'node:test';
import assert from 'node:assert/strict';
import { mkRng, hashSeed, lobbyCode } from '../js/engine/rng.js';

test('same seed gives the same stream', () => {
  const a = mkRng({ rngState: 42 });
  const b = mkRng({ rngState: 42 });
  for (let i = 0; i < 100; i++) assert.equal(a(), b());
});

test('different seeds diverge', () => {
  const a = mkRng({ rngState: 1 });
  const b = mkRng({ rngState: 2 });
  assert.notEqual(a(), b());
});

test('the generator writes its state back to the holder', () => {
  const holder = { rngState: 5 };
  const rng = mkRng(holder);
  rng();
  assert.notEqual(holder.rngState, 5);
  // A fresh generator over the mutated holder continues the same stream.
  const snapshot = { ...holder };
  const x = rng();
  assert.equal(mkRng(snapshot)(), x);
});

test('output stays in range', () => {
  const rng = mkRng({ rngState: 123 });
  for (let i = 0; i < 20000; i++) {
    const v = rng();
    assert.ok(v >= 0 && v < 1);
  }
  for (let i = 0; i < 1000; i++) {
    const v = rng.int(7);
    assert.ok(Number.isInteger(v) && v >= 0 && v < 7);
  }
});

test('weighted picks respect their weights', () => {
  const rng = mkRng({ rngState: 3 });
  const counts = { a: 0, b: 0 };
  for (let i = 0; i < 20000; i++) counts[rng.weighted([['a', 3], ['b', 1]])]++;
  const ratio = counts.a / counts.b;
  assert.ok(ratio > 2.6 && ratio < 3.4, `ratio ${ratio}`);
});

test('weighted copes with degenerate tables', () => {
  const rng = mkRng({ rngState: 3 });
  assert.equal(rng.weighted([['only', 0]]), 'only');
  assert.equal(rng.weighted([]), undefined);
});

test('hashSeed is stable and spread out', () => {
  assert.equal(hashSeed('ghostline'), hashSeed('ghostline'));
  assert.notEqual(hashSeed('a'), hashSeed('b'));
  const seen = new Set();
  for (let i = 0; i < 5000; i++) seen.add(hashSeed(`room-${i}`));
  assert.ok(seen.size > 4990, `collisions: ${5000 - seen.size}`);
});

test('lobby codes are four unambiguous characters', () => {
  const rng = mkRng({ rngState: 9 });
  const seen = new Set();
  for (let i = 0; i < 3000; i++) {
    const code = lobbyCode(rng);
    assert.match(code, /^[BCDFGHJKLMNPQRSTVWXZ23456789]{4}$/);
    seen.add(code);
  }
  // No vowels means no accidental words, and plenty of room for collisions to be rare.
  assert.ok(seen.size > 2800, `only ${seen.size} distinct`);
});
