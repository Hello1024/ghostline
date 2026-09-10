import test from 'node:test';
import assert from 'node:assert/strict';
import * as geo from '../js/engine/geo.js';
import { mkRng } from '../js/engine/rng.js';

const BIG_BEN = { lat: 51.50073, lon: -0.12462 };
const TOWER = { lat: 51.50811, lon: -0.07597 };

test('distance matches a known real-world pair', () => {
  // Big Ben to the Tower of London is about 3.5 km.
  const d = geo.distance(BIG_BEN, TOWER);
  assert.ok(d > 3400 && d < 3600, `got ${d}`);
});

test('distance is symmetric and zero on identity', () => {
  assert.equal(geo.distance(BIG_BEN, BIG_BEN), 0);
  assert.ok(Math.abs(geo.distance(BIG_BEN, TOWER) - geo.distance(TOWER, BIG_BEN)) < 1e-6);
});

test('destination round-trips through distance and bearing', () => {
  for (const brg of [0, 45, 90, 180, 271, 359]) {
    for (const dist of [1, 50, 800, 5000]) {
      const p = geo.destination(BIG_BEN, brg, dist);
      assert.ok(Math.abs(geo.distance(BIG_BEN, p) - dist) < 0.01, `dist ${dist}@${brg}`);
      const back = geo.bearing(BIG_BEN, p);
      // Smallest signed angle between the two bearings, so 0 and 359.999 agree.
      const diff = Math.abs(((back - brg + 540) % 360) - 180);
      assert.ok(diff < 0.01, `bearing ${brg} -> ${back}`);
    }
  }
});

test('offset and toLocal are inverses', () => {
  const rng = mkRng({ rngState: 7 });
  for (let i = 0; i < 200; i++) {
    const e = rng.range(-2000, 2000);
    const n = rng.range(-2000, 2000);
    const l = geo.toLocal(BIG_BEN, geo.offset(BIG_BEN, e, n));
    assert.ok(Math.abs(l.x - e) < 0.01 && Math.abs(l.y - n) < 0.01);
  }
});

test('a one-mile square really is a mile on each side', () => {
  const b = geo.squareBounds(BIG_BEN, 1609);
  const south = geo.distance({ lat: b.minLat, lon: b.minLon }, { lat: b.minLat, lon: b.maxLon });
  const west = geo.distance({ lat: b.minLat, lon: b.minLon }, { lat: b.maxLat, lon: b.minLon });
  assert.ok(Math.abs(south - 1609) < 2, `south ${south}`);
  assert.ok(Math.abs(west - 1609) < 2, `west ${west}`);
});

test('bounds tests agree with distanceOutside', () => {
  const b = geo.squareBounds(BIG_BEN, 1000);
  assert.ok(geo.inBounds(b, BIG_BEN));
  assert.equal(geo.distanceOutside(b, BIG_BEN), 0);
  const out = geo.destination(BIG_BEN, 90, 900);
  assert.ok(!geo.inBounds(b, out));
  assert.ok(Math.abs(geo.distanceOutside(b, out) - 400) < 2);
  assert.ok(geo.inBounds(b, geo.clampToBounds(b, out)));
});

test('randomPointIn always lands inside, jitter respects its radius', () => {
  const rng = mkRng({ rngState: 99 });
  const b = geo.squareBounds(BIG_BEN, 1609);
  for (let i = 0; i < 2000; i++) {
    assert.ok(geo.inBounds(b, geo.randomPointIn(b, rng)));
    assert.ok(geo.distance(BIG_BEN, geo.jitter(BIG_BEN, 75, rng)) <= 75.0001);
  }
});

test('distance handles the antimeridian and poles without exploding', () => {
  const a = { lat: 0, lon: 179.999 };
  const b = { lat: 0, lon: -179.999 };
  const d = geo.distance(a, b);
  assert.ok(Number.isFinite(d) && d < 500, `got ${d}`);
  assert.ok(Number.isFinite(geo.distance({ lat: 89.9, lon: 0 }, { lat: 89.9, lon: 180 })));
  const wrapped = geo.destination({ lat: 0, lon: 179.99 }, 90, 5000);
  assert.ok(wrapped.lon >= -180 && wrapped.lon <= 180, `lon ${wrapped.lon}`);
});

test('compassPoint covers the dial', () => {
  assert.equal(geo.compassPoint(0), 'N');
  assert.equal(geo.compassPoint(90), 'E');
  assert.equal(geo.compassPoint(181), 'S');
  assert.equal(geo.compassPoint(359), 'N');
});
