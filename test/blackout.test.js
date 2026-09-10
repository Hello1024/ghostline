/**
 * The blackout rule — the answer to "put the phone in your pocket and sneak".
 *
 * Three things have to hold:
 *   1. a glance at a notification costs you nothing,
 *   2. going away costs you, whether or not your client admits it,
 *   3. covering ground while away gets you lit up for the other team.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyIntent, step, isDarkNow } from '../js/engine/engine.js';
import { viewFor } from '../js/engine/view.js';
import * as geo from '../js/engine/geo.js';
import { makeGame, place, start, run, heartbeat, give, charge, hasFeed, T0, CENTRE } from './_util.mjs';

/** A player who tells us the screen is gone and then stops talking. */
function goDark(s, id, now) {
  applyIntent(s, id, { type: 'presence', visible: false, wakeLock: false }, now);
}
function comeBack(s, id, now, at = null) {
  applyIntent(s, id, { type: 'presence', visible: true, wakeLock: true }, now);
  if (at) applyIntent(s, id, { type: 'fix', lat: at.lat, lon: at.lon, acc: 5, at: now }, now);
}

test('a quick glance away is free', () => {
  const s = makeGame({ config: { scatterS: 0, darkGraceS: 8 } });
  start(s);
  place(s, 'h1', 900, 0); place(s, 'g1', 0, 0);
  let now = s.t;
  goDark(s, 'g1', now);
  now = run(s, 5000, { each: (t) => { heartbeat(s, t, ['h1']); } });
  assert.equal(isDarkNow(s, s.players.g1, now), false, 'penalised inside the grace window');
  comeBack(s, 'g1', now, geo.offset(CENTRE, 0, 0));
  step(s, now + 500);
  assert.equal(s.players.g1.dark.totalMs, 0);
  assert.equal(s.players.g1.dark.jumps, 0);
});

test('staying away drains charge and beacons you to the other side', () => {
  const s = makeGame({ config: { scatterS: 0, darkGraceS: 8, darkDrainPerS: 3, chargeStart: 150 } });
  start(s);
  place(s, 'h1', 900, 0); place(s, 'g1', 0, 0);
  let now = s.t;
  goDark(s, 'g1', now);
  now = run(s, 30_000, { each: (t) => heartbeat(s, t, ['h1']) });
  const g = s.players.g1;
  assert.ok(isDarkNow(s, g, now), 'not marked dark');
  assert.ok(g.dark.totalMs > 18_000, `only ${g.dark.totalMs}ms counted`);
  assert.ok(g.charge < 100, `charge ${g.charge} — no drain`);
  // The hunter can see exactly where the sulking ghost is.
  const hunterView = viewFor(s, 'h1', now);
  const beacon = hunterView.reveals.find((r) => r.kind === 'dark');
  assert.ok(beacon, 'no blackout beacon');
  assert.equal(beacon.blur, 0, 'the beacon should be exact');
  assert.ok(geo.distance(beacon, g) < 1, 'the beacon does not track the player');
  // And it is one beacon, not thirty stacked on top of each other.
  assert.equal(hunterView.reveals.filter((r) => r.kind === 'dark').length, 1);
});

test('silence counts as dark even if the client insists it is awake', () => {
  // This is the one that matters: the check cannot depend on an honest client.
  const s = makeGame({ config: { scatterS: 0, fixTimeoutS: 12 } });
  start(s);
  place(s, 'h1', 900, 0); place(s, 'g1', 0, 0);
  applyIntent(s, 'g1', { type: 'presence', visible: true, wakeLock: true }, s.t);
  const now = run(s, 40_000, { each: (t) => heartbeat(s, t, ['h1']) });
  assert.ok(isDarkNow(s, s.players.g1, now), 'a silent client escaped the rule');
  assert.ok(viewFor(s, 'h1', now).reveals.some((r) => r.kind === 'dark'));
});

test('moving at a walking pace while away is penalised but not flagged', () => {
  const s = makeGame({ config: { scatterS: 0, darkWalkSpeedMs: 2.2, darkSlackM: 30 } });
  start(s);
  place(s, 'h1', 900, 0); place(s, 'g1', 0, 0);
  let now = s.t;
  goDark(s, 'g1', now);
  now = run(s, 60_000, { each: (t) => heartbeat(s, t, ['h1']) });
  comeBack(s, 'g1', now, geo.offset(CENTRE, 80, 0));   // 80m in 60s: a stroll
  step(s, now + 500);
  const g = s.players.g1;
  assert.equal(g.dark.jumps, 0, 'an honest player was accused');
  assert.equal(g.dark.flaggedUntil, 0);
  assert.ok(g.dark.totalMs > 45_000, 'the time away went unrecorded');
});

test('covering ground while away gets you flagged and locked out', () => {
  const s = makeGame({ config: { scatterS: 0, darkWalkSpeedMs: 2.2, darkSlackM: 30, ghostFlagS: 30 } });
  start(s);
  place(s, 'h1', 900, 0); place(s, 'g1', 0, 0);
  give(s, 'g1', 'cloak'); charge(s, 'g1', 200);
  let now = s.t;
  goDark(s, 'g1', now);
  now = run(s, 60_000, { each: (t) => heartbeat(s, t, ['h1']) });
  comeBack(s, 'g1', now, geo.offset(CENTRE, 600, 0));  // 600m in 60s: a car
  step(s, now + 500);
  const g = s.players.g1;
  assert.equal(g.dark.jumps, 1, 'the jump went unnoticed');
  assert.ok(g.dark.flaggedUntil > s.t, 'no punishment reveal');
  assert.ok(g.fx.lockout > s.t, 'abilities were not locked');
  assert.equal(applyIntent(s, 'g1', { type: 'use', item: 'cloak' }, s.t).error, 'locked-out');
  assert.ok(hasFeed(s, 'flag'));
  // Everybody sees the flag land — it is a public shaming, by design.
  assert.ok(viewFor(s, 'h1', s.t).reveals.some((r) => r.kind === 'flag'), 'hunters cannot see the flagged ghost');
  assert.ok(viewFor(s, 'h1', s.t).feed.some((e) => e.type === 'flag'));
  assert.ok(viewFor(s, 'g1', s.t).feed.some((e) => e.type === 'flag'));
});

test('the rule applies to hunters too', () => {
  const s = makeGame({ config: { scatterS: 0 } });
  start(s);
  place(s, 'h1', 0, 0); place(s, 'g1', 900, 0);
  let now = s.t;
  goDark(s, 'h1', now);
  now = run(s, 40_000, { each: (t) => heartbeat(s, t, ['g1']) });
  const ghostView = viewFor(s, 'g1', now);
  assert.ok(ghostView.reveals.some((r) => r.kind === 'dark'), 'a dark hunter is invisible to ghosts');
  assert.ok(s.players.h1.dark.totalMs > 25_000);
});

test('going dark cancels a cloak — no hiding in your pocket', () => {
  const s = makeGame({ config: { scatterS: 0 } });
  start(s);
  place(s, 'h1', 900, 0); place(s, 'g1', 0, 0);
  give(s, 'g1', 'cloak'); charge(s, 'g1', 200);
  applyIntent(s, 'g1', { type: 'use', item: 'cloak' }, s.t);
  assert.ok(s.players.g1.fx.cloak > s.t);
  goDark(s, 'g1', s.t);
  run(s, 20_000, { each: (t) => heartbeat(s, t, ['h1']) });
  assert.equal(s.players.g1.fx.cloak, 0, 'the cloak survived a blackout');
});

test('blink sheds a flag and its beacon', () => {
  const s = makeGame({ config: { scatterS: 0 } });
  start(s);
  place(s, 'h1', 900, 0); place(s, 'g1', 0, 0);
  let now = s.t;
  goDark(s, 'g1', now);
  now = run(s, 60_000, { each: (t) => heartbeat(s, t, ['h1']) });
  comeBack(s, 'g1', now, geo.offset(CENTRE, 600, 0));
  step(s, now + 500);
  assert.ok(s.players.g1.dark.flaggedUntil > s.t);
  give(s, 'g1', 'blink'); charge(s, 'g1', 200);
  assert.ok(applyIntent(s, 'g1', { type: 'use', item: 'blink' }, s.t).ok);
  step(s, s.t + 500);
  assert.equal(s.players.g1.dark.flaggedUntil, 0);
  assert.equal(s.players.g1.fx.lockout, 0);
  assert.ok(!viewFor(s, 'h1', s.t).reveals.some((r) => ['flag', 'dark'].includes(r.kind)), 'beacon survived');
});

test('a ghost in the dark banks no survival score', () => {
  const mk = (dark) => {
    const s = makeGame({ config: { scatterS: 0, durationS: 1800 } });
    start(s);
    place(s, 'h1', 900, 0); place(s, 'g1', 0, 0);
    if (dark) goDark(s, 'g1', s.t);
    run(s, 60_000, { each: (t) => heartbeat(s, t, dark ? ['h1'] : ['h1', 'g1']) });
    return s.players.g1.score;
  };
  const lit = mk(false);
  const gone = mk(true);
  assert.ok(lit > 40, `lit score ${lit}`);
  assert.ok(gone < lit / 2, `dark score ${gone} vs lit ${lit}`);
});

test('the time-in-the-dark ledger survives into the scoreboard', () => {
  const s = makeGame({ config: { scatterS: 0 } });
  start(s);
  place(s, 'h1', 900, 0); place(s, 'g1', 0, 0);
  goDark(s, 'g1', s.t);
  const now = run(s, 45_000, { each: (t) => heartbeat(s, t, ['h1']) });
  const me = viewFor(s, 'g1', now).me;
  assert.ok(me.dark.active);
  assert.ok(me.dark.totalMs > 30_000);
});
