/**
 * Arbitrary play areas.
 *
 * Real ground has a river down one side and a dual carriageway across the top,
 * so the boundary is whatever shape the host drew. The awkward case is a
 * concave one — the notch of an L is *outside* the area even though it sits
 * inside the bounding box, and anything that quietly falls back to a bounding
 * box will pass a square test and fail here.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as geo from '../js/engine/geo.js';
import { applyIntent, step, polygonProblem, MAX_VERTICES } from '../js/engine/engine.js';
import { createGame, addPlayer, spawnCaches, shapeFrom, zonePolygon } from '../js/engine/state.js';
import { viewFor } from '../js/engine/view.js';
import { mkRng } from '../js/engine/rng.js';
import { runMatch } from './harness.mjs';
import { checkInvariants, T0, CENTRE } from './_util.mjs';

/** An L: everything but the top-right quadrant of a 900m square. */
const L_SHAPE = [
  geo.offset(CENTRE, -450, -450),
  geo.offset(CENTRE, 450, -450),
  geo.offset(CENTRE, 450, 0),
  geo.offset(CENTRE, 0, 0),
  geo.offset(CENTRE, 0, 450),
  geo.offset(CENTRE, -450, 450),
];
/** A point in the missing quadrant: inside the bounding box, outside the area. */
const IN_THE_NOTCH = geo.offset(CENTRE, 225, 225);
const WELL_INSIDE = geo.offset(CENTRE, -225, -225);

function lGame(config = {}) {
  const s = createGame({
    seed: 'poly', area: { polygon: L_SHAPE }, now: T0, hostId: 'h1', code: 'POLY',
    config: { durationS: 1800, scatterS: 0, ...config },
  });
  addPlayer(s, { id: 'h1', name: 'h1' }); s.players.h1.role = 'hunter';
  addPlayer(s, { id: 'g1', name: 'g1' }); s.players.g1.role = 'ghost';
  return s;
}
const put = (s, id, at, now = s.t) =>
  applyIntent(s, id, { type: 'fix', lat: at.lat, lon: at.lon, acc: 5, at: now }, now);

test('a play area keeps the shape it was given', () => {
  const s = lGame();
  assert.equal(s.area.polygon.length, 6);
  assert.equal(s.zone.polygon.length, 6);
  // ~0.6 km²: the 900m square less its missing quarter.
  assert.ok(Math.abs(s.area.areaM2 - 607_500) < 5_000, `area ${s.area.areaM2}`);
  assert.ok(geo.distance(s.area, geo.polygonCentroid(L_SHAPE)) < 1);
});

test('the notch of a concave area is out of bounds', () => {
  const s = lGame({ oobGraceS: 5, chargeStart: 120 });
  applyIntent(s, 'h1', { type: 'start' }, T0);
  put(s, 'h1', geo.offset(CENTRE, -400, -400));
  put(s, 'g1', WELL_INSIDE);
  step(s, s.t + 500);
  assert.equal(s.players.g1.oobSince, 0, 'a player well inside was marked out');
  assert.equal(viewFor(s, 'g1', s.t).me.outsideM, 0);

  // Step into the missing quadrant: inside the bounding box, outside the area.
  let now = s.t;
  for (let i = 0; i < 30; i++) { now += 500; put(s, 'g1', IN_THE_NOTCH, now); step(s, now); }
  assert.ok(s.players.g1.oobSince > 0, 'the notch was treated as playable');
  assert.ok(viewFor(s, 'g1', now).me.outsideM > 100, 'no sense of how far out they are');
  assert.ok(s.players.g1.charge < 120, 'no drain in the notch');
  assert.ok(viewFor(s, 'h1', now).reveals.some((r) => r.kind === 'oob'), 'a stray was not exposed');
});

test('caches only ever spawn on playable ground', () => {
  const s = lGame({ cacheCount: 40 });
  spawnCaches(s);
  assert.equal(s.caches.length, 40);
  for (const c of s.caches) {
    assert.ok(geo.pointInPolygon(L_SHAPE, c), `cache at ${c.lat},${c.lon} is off the map`);
  }
});

test('a cache stranded by the collapse is pulled back inside', () => {
  const s = lGame({ cacheCount: 6, durationS: 600, collapseS: 300 });
  applyIntent(s, 'h1', { type: 'start' }, T0);
  put(s, 'h1', WELL_INSIDE);
  put(s, 'g1', geo.offset(CENTRE, -400, 400));
  let now = T0;
  for (let i = 0; i < 1300; i++) {
    now += 500;
    put(s, 'h1', WELL_INSIDE, now);
    put(s, 'g1', geo.offset(CENTRE, -400, 400), now);
    step(s, now);
    if (s.phase === 'over') break;
  }
  const poly = zonePolygon(s);
  for (const c of s.caches) {
    if (c.takenBy) continue;
    assert.ok(geo.pointInPolygon(poly, c), 'a cache was left outside the closed zone');
  }
});

test('the zone keeps its shape as it closes', () => {
  const s = lGame({ durationS: 600, collapseS: 300 });
  applyIntent(s, 'h1', { type: 'start' }, T0);
  put(s, 'h1', WELL_INSIDE);
  put(s, 'g1', geo.offset(CENTRE, -400, 400));
  let now = T0;
  for (let i = 0; i < 1180; i++) {
    now += 500;
    put(s, 'h1', WELL_INSIDE, now);
    put(s, 'g1', geo.offset(CENTRE, -430, 430), now);
    step(s, now);
  }
  assert.equal(s.zone.polygon.length, 6, 'the zone stopped being the shape it started as');
  assert.ok(s.zone.areaM2 < s.area.areaM2 * 0.5, `zone ${s.zone.areaM2} of ${s.area.areaM2}`);
  // Still concave, still centred where it was.
  assert.ok(!geo.pointInPolygon(s.zone.polygon, IN_THE_NOTCH), 'the notch closed up');
  assert.ok(geo.distance(s.zone, s.area) < 5, 'the zone drifted off centre');
});

test('a drawn area is checked before anyone plays on it', () => {
  const tiny = geo.squarePolygon(CENTRE, 120);
  const huge = geo.squarePolygon(CENTRE, 9000);
  const bowTie = [CENTRE, geo.offset(CENTRE, 600, 600), geo.offset(CENTRE, 600, 0), geo.offset(CENTRE, 0, 600)];
  const tooMany = geo.regularPolygon(CENTRE, 1200, MAX_VERTICES + 5);

  assert.equal(polygonProblem(L_SHAPE), null);
  assert.equal(polygonProblem(geo.squarePolygon(CENTRE, 1609)), null);
  assert.equal(polygonProblem(tiny), 'area-too-small');
  assert.equal(polygonProblem(huge), 'area-too-big');
  assert.equal(polygonProblem(bowTie), 'area-crosses-itself');
  assert.equal(polygonProblem(tooMany), 'too-many-corners');
  assert.equal(polygonProblem([CENTRE, geo.offset(CENTRE, 10, 0)]), 'bad-area');
  assert.equal(polygonProblem(null), 'bad-area');
  assert.equal(polygonProblem([CENTRE, geo.offset(CENTRE, 900, 0), { lat: NaN, lon: 0 }]), 'bad-area');
});

test('the host can set a polygon area, and a bad one is refused', () => {
  const s = lGame();
  const ok = applyIntent(s, 'h1', { type: 'area', polygon: L_SHAPE }, T0);
  assert.equal(ok.ok, true);
  assert.equal(s.area.polygon.length, 6);
  assert.equal(s.zone.polygon.length, 6);

  const before = JSON.stringify(s.area);
  const bad = applyIntent(s, 'h1', { type: 'area', polygon: geo.squarePolygon(CENTRE, 50) }, T0);
  assert.equal(bad.ok, false);
  assert.equal(bad.error, 'area-too-small');
  assert.equal(JSON.stringify(s.area), before, 'a refused area was applied anyway');

  // A bare centre still works and becomes a square.
  assert.ok(applyIntent(s, 'h1', { type: 'area', lat: CENTRE.lat, lon: CENTRE.lon, sizeM: 1200 }, T0).ok);
  assert.equal(s.area.polygon.length, 4);
});

test('a whole match plays out on a concave area', () => {
  const problems = [];
  const { state, trace } = runMatch({
    seed: 'concave', players: 7, hunters: 2, minutes: 20,
    area: { polygon: L_SHAPE },
    onTick: (st, now) => {
      if (Math.round(now / 500) % 80 !== 0) return;
      problems.push(...checkInvariants(st, `t=${now}`));
      for (const c of st.caches) {
        if (!c.takenBy && !geo.pointInPolygon(zonePolygon(st), c)) problems.push('cache outside the zone');
      }
    },
  });
  assert.deepEqual(problems.slice(0, 4), []);
  assert.deepEqual(trace.errors.slice(0, 3), []);
  assert.equal(state.phase, 'over');
  assert.ok(trace.cachesTaken > 5, `only ${trace.cachesTaken} caches opened`);
  assert.equal(state.zone.polygon.length, 6);
});

test('bots stay on playable ground when the area is concave', () => {
  let strayTicks = 0;
  let samples = 0;
  runMatch({
    seed: 'stay-in', players: 7, hunters: 2, minutes: 20,
    area: { polygon: L_SHAPE },
    onTick: (st, now) => {
      if (Math.round(now / 500) % 60 !== 0) return;
      const poly = zonePolygon(st);
      for (const p of Object.values(st.players)) {
        if (p.lat == null) continue;
        samples++;
        if (geo.distanceOutsidePolygon(poly, p) > 60) strayTicks++;
      }
    },
  });
  assert.ok(samples > 100, 'no samples taken');
  // Bots wander and the zone closes on them, so the odd stray is expected —
  // but they should not be living in the notch.
  assert.ok(strayTicks / samples < 0.25, `${Math.round((strayTicks / samples) * 100)}% of samples were well outside`);
});
