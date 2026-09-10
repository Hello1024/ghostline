import test from 'node:test';
import assert from 'node:assert/strict';
import { applyIntent, step, pulseInterval, isRunning } from '../js/engine/engine.js';
import { viewFor } from '../js/engine/view.js';
import { spawnCaches, zoneBounds } from '../js/engine/state.js';
import * as geo from '../js/engine/geo.js';
import { makeGame, place, start, run, heartbeat, give, charge, hasFeed, T0, CENTRE } from './_util.mjs';

test('a match will not start without an area, a hunter and a ghost', () => {
  const s = makeGame({ players: ['h1', 'g1'], roles: { h1: 'hunter', g1: 'ghost' } });
  s.area.lat = 0; s.area.lon = 0;
  assert.equal(applyIntent(s, 'h1', { type: 'start' }, T0).error, 'no-area');
  s.area = { ...CENTRE, sizeM: 1609 };
  s.players.g1.role = 'hunter';
  assert.equal(applyIntent(s, 'h1', { type: 'start' }, T0).error, 'need-a-ghost');
  s.players.g1.role = 'ghost';
  s.players.h1.role = 'ghost';
  assert.equal(applyIntent(s, 'h1', { type: 'start' }, T0).error, 'need-a-hunter');
  s.players.h1.role = 'hunter';
  assert.ok(applyIntent(s, 'h1', { type: 'start' }, T0).ok);
  assert.equal(s.phase, 'scatter');
});

test('only the host may start, reconfigure or reassign roles', () => {
  const s = makeGame();
  for (const intent of [{ type: 'start' }, { type: 'config', config: {} },
    { type: 'area', lat: 1, lon: 1 }, { type: 'setRole', target: 'g1', role: 'hunter' }]) {
    assert.equal(applyIntent(s, 'g1', intent, T0).error, 'not-host', intent.type);
  }
});

test('nobody can be caught during the head start', () => {
  const s = makeGame({ config: { scatterS: 120 } });
  start(s);
  place(s, 'h1', 0, 0);
  place(s, 'g1', 3, 0);           // standing right next to each other
  run(s, 30_000, { each: (now) => heartbeat(s, now) });
  assert.equal(s.phase, 'scatter');
  assert.equal(s.players.g1.role, 'ghost', 'tagged during the head start');
});

test('a catch needs the hunter to hold contact for the dwell time', () => {
  const s = makeGame({ config: { scatterS: 0, catchDwellS: 3, catchRadiusM: 20 } });
  start(s);
  place(s, 'h1', 0, 0);
  place(s, 'g1', 10, 0);
  run(s, 2000, { each: (now) => heartbeat(s, now) });
  assert.equal(s.players.g1.role, 'ghost', 'caught too early');
  run(s, 2000, { each: (now) => heartbeat(s, now) });
  assert.equal(s.players.g1.role, 'hunter', 'never caught');
  assert.equal(s.players.h1.catches, 1);
  assert.ok(s.players.h1.score >= 300);
  assert.ok(hasFeed(s, 'caught'));
});

test('breaking contact resets the dwell timer', () => {
  const s = makeGame({ config: { scatterS: 0, catchDwellS: 3 } });
  start(s);
  place(s, 'h1', 0, 0);
  place(s, 'g1', 10, 0);
  run(s, 2000, { each: (now) => heartbeat(s, now) });
  place(s, 'g1', 200, 0);                       // bolts out of range
  run(s, 2000, { each: (now) => heartbeat(s, now) });
  place(s, 'g1', 10, 0);                        // comes back
  run(s, 2000, { each: (now) => heartbeat(s, now) });
  assert.equal(s.players.g1.role, 'ghost', 'dwell timer did not reset');
});

test('a freshly converted hunter is frozen before joining in', () => {
  const s = makeGame({
    players: ['h1', 'g1', 'g2'], roles: { h1: 'hunter', g1: 'ghost', g2: 'ghost' },
    config: { scatterS: 0, convertS: 30 },
  });
  start(s);
  place(s, 'h1', 0, 0); place(s, 'g1', 5, 0); place(s, 'g2', 600, 0);
  run(s, 4000, { each: (now) => heartbeat(s, now) });
  assert.equal(s.players.g1.role, 'hunter');
  assert.ok(s.players.g1.convertAt > s.t, 'no conversion freeze');
  // Park the new hunter on top of g2: a frozen player must not be able to tag.
  place(s, 'g1', 598, 0);
  run(s, 6000, { each: (now) => heartbeat(s, now) });
  assert.equal(s.players.g2.role, 'ghost', 'a frozen hunter made a catch');
  // Once thawed, the same contact does convert.
  run(s, 30_000, { each: (now) => heartbeat(s, now) });
  assert.equal(s.players.g2.role, 'hunter', 'the freeze never wore off');
});

test('with infection off a caught ghost becomes a spectator', () => {
  const s = makeGame({ config: { scatterS: 0, infection: false } });
  start(s);
  place(s, 'h1', 0, 0); place(s, 'g1', 5, 0);
  run(s, 4000, { each: (now) => heartbeat(s, now) });
  assert.equal(s.players.g1.role, 'spectator');
  assert.equal(s.phase, 'over');
  assert.equal(s.outcome, 'hunters');
});

test('walking earns charge; a teleport earns nothing', () => {
  const s = makeGame({ config: { scatterS: 0, chargeStart: 0 } });
  start(s);
  place(s, 'g1', 0, 0);
  let now = T0;
  for (let i = 1; i <= 20; i++) { now += 1000; place(s, 'g1', i * 1.4, 0, now); }
  const walked = s.players.g1.charge;
  assert.ok(walked > 8 && walked < 11, `charge ${walked} for ~28m`);
  place(s, 'g1', 5000, 0, now + 1000);            // 5 km in one second
  assert.equal(s.players.g1.charge, walked, 'a teleport paid out');
  assert.ok(hasFeed(s, 'jump'));
});

test('charge is capped and a sloppy fix earns nothing', () => {
  const s = makeGame({ config: { scatterS: 0, chargeStart: 199, maxAccuracyM: 50 } });
  start(s);
  place(s, 'g1', 0, 0);
  let now = T0;
  for (let i = 1; i <= 10; i++) { now += 1000; place(s, 'g1', i * 2, 0, now); }
  assert.equal(s.players.g1.charge, s.config.chargeMax);
  const s2 = makeGame({ config: { scatterS: 0, chargeStart: 0 } });
  start(s2);
  place(s2, 'g1', 0, 0, T0, 200);
  place(s2, 'g1', 20, 0, T0 + 1000, 200);          // 200m accuracy: junk
  assert.equal(s2.players.g1.charge, 0);
});

test('a cache is opened by standing on it, and grants an item and charge', () => {
  const s = makeGame({ config: { scatterS: 0, cacheCount: 0, cacheDwellS: 2, chargeStart: 0 } });
  start(s);
  s.caches = [{ id: 'c1', ...geo.offset(CENTRE, 100, 0), takenBy: null, respawnAt: 0 }];
  place(s, 'g1', 100, 0);
  run(s, 1000, { each: (now) => heartbeat(s, now) });
  assert.equal(s.players.g1.caches, 0, 'opened before the dwell finished');
  run(s, 2000, { each: (now) => heartbeat(s, now) });
  assert.equal(s.players.g1.caches, 1);
  assert.equal(s.players.g1.items.length, 1);
  assert.ok(s.players.g1.charge >= 25);
  assert.ok(s.caches[0].takenBy === 'g1' && s.caches[0].respawnAt > s.t);
});

test('a cache found with full hands pays out charge instead of being wasted', () => {
  const s = makeGame({ config: { scatterS: 0, cacheCount: 0, cacheDwellS: 1, chargeStart: 0, inventorySize: 3 } });
  start(s);
  give(s, 'g1', 'cloak', 'decoy', 'static');
  s.caches = [{ id: 'c1', ...geo.offset(CENTRE, 100, 0), takenBy: null, respawnAt: 0 }];
  place(s, 'g1', 100, 0);
  run(s, 3000, { each: (now) => heartbeat(s, now) });
  assert.equal(s.players.g1.items.length, 3, 'inventory overflowed');
  assert.ok(s.players.g1.charge >= 60, `charge ${s.players.g1.charge}`);
});

test('caches respawn elsewhere inside the zone', () => {
  const s = makeGame({ config: { scatterS: 0, cacheCount: 0, cacheDwellS: 1, cacheRespawnS: 10 } });
  start(s);
  const where = geo.offset(CENTRE, 100, 0);
  s.caches = [{ id: 'c1', ...where, takenBy: null, respawnAt: 0 }];
  place(s, 'g1', 100, 0);
  run(s, 3000, { each: (now) => heartbeat(s, now) });
  assert.equal(s.caches[0].takenBy, 'g1');
  run(s, 12_000, { each: (now) => heartbeat(s, now) });
  assert.equal(s.caches[0].takenBy, null, 'never came back');
  assert.ok(geo.distance(s.caches[0], where) > 0, 'respawned in the same spot');
  assert.ok(geo.inBounds(zoneBounds(s), s.caches[0]));
});

test('items need to be held, affordable and role-appropriate', () => {
  const s = makeGame({ config: { scatterS: 0 } });
  start(s);
  place(s, 'g1', 0, 0);
  assert.equal(applyIntent(s, 'g1', { type: 'use', item: 'cloak' }, s.t).error, 'not-held');
  give(s, 'g1', 'cloak');
  charge(s, 'g1', 10);
  assert.equal(applyIntent(s, 'g1', { type: 'use', item: 'cloak' }, s.t).error, 'not-enough-charge');
  charge(s, 'g1', 100);
  assert.ok(applyIntent(s, 'g1', { type: 'use', item: 'cloak' }, s.t).ok);
  assert.equal(s.players.g1.items.length, 0, 'item was not consumed');
  assert.equal(s.players.g1.charge, 40);
  give(s, 'g1', 'sonar');
  assert.equal(applyIntent(s, 'g1', { type: 'use', item: 'sonar' }, s.t).error, 'wrong-role');
  assert.equal(applyIntent(s, 'g1', { type: 'use', item: 'nope' }, s.t).error, 'no-such-item');
});

test('the pulse fires on schedule and its interval accelerates', () => {
  const s = makeGame({ config: { scatterS: 60, durationS: 1800, pingIntervalS: 135, pingCollapseIntervalS: 45 } });
  start(s);
  place(s, 'g1', 0, 0); place(s, 'h1', 500, 0);
  assert.equal(s.pulse.nextAt, T0 + 60_000, 'first pulse is not at the end of the head start');
  const early = pulseInterval(s, T0);
  const late = pulseInterval(s, T0 + 1_790_000);
  assert.ok(Math.abs(early - 135) < 1, `early ${early}`);
  assert.ok(late < 50, `late ${late}`);
  run(s, 61_000, { each: (now) => heartbeat(s, now) });
  assert.equal(s.pulse.count, 1);
  assert.ok(s.reveals.some((r) => r.kind === 'pulse' && r.target === 'g1'));
});

test('the pulse blur reflects how fast you were moving, and running leaks a heading', () => {
  const mk = (speed) => {
    const s = makeGame({ config: { scatterS: 0, pingIntervalS: 10 } });
    start(s);
    place(s, 'h1', 800, 0);
    let now = T0;
    place(s, 'g1', 0, 0, now);
    for (let i = 1; i <= 12; i++) { now += 1000; place(s, 'g1', i * speed, 0, now); }
    step(s, now + 1000);
    return { s, reveal: s.reveals.find((r) => r.kind === 'pulse') };
  };
  const still = mk(0);
  const walk = mk(1.2);
  const runFast = mk(3.0);
  assert.ok(still.reveal.blur < walk.reveal.blur, 'standing still was not the tightest fix');
  assert.ok(runFast.reveal.blur > walk.reveal.blur, 'running did not smear the fix');
  assert.equal(still.reveal.heading, null);
  assert.ok(runFast.reveal.heading != null, 'running leaked no heading');
  // The blob is never helpfully centred on the ghost.
  assert.ok(geo.distance(walk.reveal, walk.s.players.g1) > 0);
});

test('cloak hides a ghost from the pulse but a drone still finds them', () => {
  const s = makeGame({ config: { scatterS: 5, pingIntervalS: 600 } });
  start(s);
  place(s, 'h1', 700, 0);
  place(s, 'g1', 0, 0);
  give(s, 'g1', 'cloak'); charge(s, 'g1', 200);
  applyIntent(s, 'g1', { type: 'use', item: 'cloak' }, s.t);
  run(s, 6000, { each: (now) => heartbeat(s, now) });
  assert.equal(s.pulse.count, 1);
  assert.ok(!s.reveals.some((r) => r.kind === 'pulse' && r.target === 'g1'), 'cloak failed');
  give(s, 'h1', 'drone'); charge(s, 'h1', 200);
  const at = geo.offset(CENTRE, 0, 0);
  applyIntent(s, 'h1', { type: 'use', item: 'drone', params: at }, s.t);
  step(s, s.t + 500);
  const view = viewFor(s, 'h1', s.t);
  assert.ok(view.reveals.some((r) => r.kind === 'drone'), 'drone did not beat the cloak');
});

test('static widens the next pulse and is spent doing it', () => {
  const s = makeGame({ config: { scatterS: 5, pingIntervalS: 600 } });
  start(s);
  place(s, 'h1', 700, 0); place(s, 'g1', 0, 0);
  give(s, 'g1', 'static'); charge(s, 'g1', 200);
  applyIntent(s, 'g1', { type: 'use', item: 'static' }, s.t);
  run(s, 6000, { each: (now) => heartbeat(s, now) });
  const r = s.reveals.find((x) => x.kind === 'pulse' && x.target === 'g1');
  assert.ok(r.blur >= s.config.pingBlurStillM * 3, `blur ${r.blur}`);
  assert.equal(s.players.g1.fx.static, 0, 'static was not consumed');
});

test('a decoy shows up as an ordinary pulse blob and then burns out', () => {
  const s = makeGame({ config: { scatterS: 5, pingIntervalS: 20 } });
  start(s);
  place(s, 'h1', 700, 0); place(s, 'g1', 0, 0);
  give(s, 'g1', 'decoy'); charge(s, 'g1', 200);
  applyIntent(s, 'g1', { type: 'use', item: 'decoy' }, s.t);
  assert.equal(s.decoys.length, 1);
  run(s, 6000, { each: (now) => heartbeat(s, now) });
  const blobs = viewFor(s, 'h1', s.t).reveals.filter((r) => r.kind === 'pulse');
  assert.equal(blobs.length, 2, 'the decoy did not appear alongside the real ghost');
  // A hunter cannot tell them apart from the shape of the data.
  assert.ok(blobs.every((b) => b.blur > 0 && b.lat != null));
  run(s, 45_000, { each: (now) => heartbeat(s, now) });
  assert.ok(s.pulse.count >= 3, `only ${s.pulse.count} pulses`);
  assert.equal(s.decoys.length, 0, 'the decoy outlived its two pulses');
});

test('tripwires cut both ways', () => {
  const s = makeGame({
    players: ['h1', 'g1'], roles: { h1: 'hunter', g1: 'ghost' },
    config: { scatterS: 0, catchRadiusM: 5, lockoutS: 25 },
  });
  start(s);
  place(s, 'g1', 0, 0);
  give(s, 'g1', 'trap'); charge(s, 'g1', 200);
  applyIntent(s, 'g1', { type: 'use', item: 'trap' }, s.t);
  place(s, 'g1', 300, 0);
  place(s, 'h1', 400, 0);
  run(s, 21_000, { each: (now) => heartbeat(s, now) });   // let it arm
  place(s, 'h1', 5, 0);
  run(s, 1500, { each: (now) => heartbeat(s, now) });
  assert.ok(s.players.h1.fx.lockout > s.t, 'the hunter walked through unharmed');
  assert.equal(applyIntent(s, 'h1', { type: 'use', item: 'sonar' }, s.t).error, 'locked-out');
});

test('the zone collapses and being outside it drains and exposes you', () => {
  const s = makeGame({ config: { scatterS: 0, durationS: 600, collapseS: 300, oobGraceS: 5, chargeStart: 100 } });
  start(s);
  place(s, 'h1', 0, 0); place(s, 'g1', 700, 700);
  const before = s.zone.sizeM;
  run(s, 450_000, { each: (now) => heartbeat(s, now) });
  assert.ok(s.zone.sizeM < before * 0.8, `zone ${s.zone.sizeM} of ${before}`);
  // Step well outside what is left.
  place(s, 'g1', s.config.areaSizeM, 0);
  run(s, 20_000, { each: (now) => heartbeat(s, now, ['h1']) });
  assert.ok(s.players.g1.oobSince > 0);
  assert.ok(s.players.g1.charge < 100, 'no drain outside the zone');
  assert.ok(viewFor(s, 'h1', s.t).reveals.some((r) => r.kind === 'oob'), 'strays are not exposed');
});

test('the match ends on the clock, and early if every ghost is caught', () => {
  const s = makeGame({ config: { scatterS: 0, durationS: 60 } });
  start(s);
  place(s, 'h1', 800, 0); place(s, 'g1', 0, 0);
  run(s, 61_000, { each: (now) => heartbeat(s, now) });
  assert.equal(s.phase, 'over');
  assert.equal(s.outcome, 'ghosts');
  assert.ok(s.players.g1.score >= s.config.scoreGhostSurvive);
  assert.equal(isRunning(s), false);

  const s2 = makeGame({ config: { scatterS: 0, durationS: 1800 } });
  start(s2);
  place(s2, 'h1', 0, 0); place(s2, 'g1', 5, 0);
  run(s2, 5000, { each: (now) => heartbeat(s2, now) });
  assert.equal(s2.phase, 'over');
  assert.equal(s2.outcome, 'hunters');
  assert.ok(s2.players.h1.score > 300, 'no sweep bonus');
});

test('a finished match ignores further input', () => {
  const s = makeGame({ config: { scatterS: 0, durationS: 30 } });
  start(s);
  place(s, 'h1', 800, 0); place(s, 'g1', 0, 0);
  run(s, 31_000, { each: (now) => heartbeat(s, now) });
  const snapshot = JSON.stringify(s.players.g1.score);
  give(s, 'g1', 'cloak'); charge(s, 'g1', 200);
  assert.equal(applyIntent(s, 'g1', { type: 'use', item: 'cloak' }, s.t).error, 'not-running');
  run(s, 10_000);
  assert.equal(JSON.stringify(s.players.g1.score), snapshot, 'score moved after the whistle');
});

test('garbage input is rejected without corrupting anything', () => {
  const s = makeGame({ config: { scatterS: 0 } });
  start(s);
  place(s, 'g1', 0, 0);
  const before = JSON.stringify(s.players.g1);
  for (const bad of [
    { type: 'fix', lat: NaN, lon: 0 }, { type: 'fix', lat: 'x', lon: 0 },
    { type: 'fix', lat: 91, lon: 0 }, { type: 'fix', lat: 0, lon: 999 },
    { type: 'nonsense' }, {}, null,
  ]) {
    const r = applyIntent(s, 'g1', bad, s.t);
    assert.equal(r.ok, false, JSON.stringify(bad));
  }
  const after = JSON.parse(JSON.stringify(s.players.g1));
  assert.equal(after.lat, JSON.parse(before).lat);
  assert.equal(applyIntent(s, 'ghost-who', { type: 'fix', lat: 1, lon: 1 }, s.t).error, 'no-such-player');
});
