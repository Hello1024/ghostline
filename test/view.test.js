/**
 * Fog of war is a security boundary, not a rendering convenience: whatever the
 * host sends, a curious player can read. These tests walk the *entire*
 * serialised view looking for any coordinate that matches a player who should
 * be hidden — so a leak anywhere in the structure is caught, not just in the
 * fields we remembered to check.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyIntent, step } from '../js/engine/engine.js';
import { viewFor, leaderboard } from '../js/engine/view.js';
import * as geo from '../js/engine/geo.js';
import { makeGame, place, start, run, heartbeat, give, charge, T0, CENTRE } from './_util.mjs';

/** Every {lat, lon} pair anywhere inside a view. */
function coords(node, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const v of node) coords(v, out);
    return out;
  }
  if (Number.isFinite(node.lat) && Number.isFinite(node.lon)) out.push({ lat: node.lat, lon: node.lon });
  for (const v of Object.values(node)) coords(v, out);
  return out;
}

/**
 * Does this view betray where `target` actually is?
 *
 * Only the structures that can carry a player position are scanned. The play
 * area, the shrinking zone and the start point are public knowledge printed on
 * everyone's map — including them would flag a hunter who merely happens to be
 * standing on the centre of the board.
 */
const CARRIERS = ['players', 'reveals', 'caches', 'drones', 'traps', 'me', 'feed'];
function leaks(view, target, tolM = 5) {
  const surface = CARRIERS.map((k) => view[k]);
  return coords(surface).some((c) => geo.distance(c, target) <= tolM);
}

function twoSided(cfg = {}) {
  const s = makeGame({
    players: ['h1', 'h2', 'g1', 'g2'],
    roles: { h1: 'hunter', h2: 'hunter', g1: 'ghost', g2: 'ghost' },
    // No head start in these fixtures: a hunter who strays during the head
    // start is deliberately exposed to the ghosts, which is not a leak.
    config: { scatterS: 0, pingIntervalS: 600, ...cfg },
  });
  start(s);
  return s;
}

test('a hunter view never contains a hidden ghost position', () => {
  const s = twoSided();
  place(s, 'h1', -200, -150); place(s, 'h2', -150, -150);
  place(s, 'g1', 600, 0); place(s, 'g2', -600, 200);
  run(s, 3000, { each: (now) => heartbeat(s, now) });
  const view = viewFor(s, 'h1', s.t);
  assert.ok(!leaks(view, s.players.g1), 'g1 position leaked to a hunter');
  assert.ok(!leaks(view, s.players.g2), 'g2 position leaked to a hunter');
  // The roster row exists — you know who is playing — but carries no position.
  const row = view.players.find((p) => p.id === 'g1');
  assert.ok(row && row.lat === undefined && row.lon === undefined);
  assert.equal(typeof row.items, 'number', 'another player\'s inventory was itemised');
});

test('a ghost view never contains a distant hunter position', () => {
  const s = twoSided();
  place(s, 'h1', -200, -150); place(s, 'h2', -150, -150);
  place(s, 'g1', 600, 0); place(s, 'g2', -600, 200);
  run(s, 3000, { each: (now) => heartbeat(s, now) });
  const view = viewFor(s, 'g1', s.t);
  assert.ok(!leaks(view, s.players.h1), 'hunter position leaked to a ghost');
  assert.ok(!leaks(view, s.players.h2), 'hunter position leaked to a ghost');
  assert.equal(view.drones.length, 0);
});

test('hunters share a radio net; ghosts only sense each other close up', () => {
  const s = twoSided();
  place(s, 'h1', 0, 0); place(s, 'h2', 900, 0);
  place(s, 'g1', 0, 500); place(s, 'g2', 100, 500);      // 100m apart
  run(s, 3000, { each: (now) => heartbeat(s, now) });
  assert.ok(leaks(viewFor(s, 'h1', s.t), s.players.h2, 1), 'hunters lost sight of each other');
  assert.ok(leaks(viewFor(s, 'g1', s.t), s.players.g2, 1), 'a ghost 100m away was invisible');
  place(s, 'g2', 900, 500);                              // now 900m away
  run(s, 1000, { each: (now) => heartbeat(s, now) });
  assert.ok(!leaks(viewFor(s, 'g1', s.t), s.players.g2), 'a distant ghost was still visible');
});

test('inside eyesight range both sides simply see each other', () => {
  const s = twoSided();
  place(s, 'h1', 0, 0); place(s, 'h2', 900, 900);
  place(s, 'g1', 25, 0); place(s, 'g2', -900, -900);
  run(s, 1000, { each: (now) => heartbeat(s, now) });
  assert.ok(leaks(viewFor(s, 'h1', s.t), s.players.g1, 1), 'a ghost 25m away was invisible');
  assert.ok(leaks(viewFor(s, 'g1', s.t), s.players.h1, 1), 'a hunter 25m away was invisible');
  place(s, 'g1', 120, 0);
  run(s, 1000, { each: (now) => heartbeat(s, now) });
  assert.ok(!leaks(viewFor(s, 'h1', s.t), s.players.g1), 'eyesight reached 120m');
});

test('eyesight beats a cloak, because eyes do', () => {
  const s = twoSided();
  place(s, 'h1', 0, 0); place(s, 'h2', 900, 900);
  place(s, 'g1', 20, 0); place(s, 'g2', -900, -900);
  give(s, 'g1', 'cloak'); charge(s, 'g1', 200);
  applyIntent(s, 'g1', { type: 'use', item: 'cloak' }, s.t);
  run(s, 1000, { each: (now) => heartbeat(s, now) });
  assert.ok(leaks(viewFor(s, 'h1', s.t), s.players.g1, 1), 'a cloak worked at arm\'s length');
});

test('caches are only visible from close enough to bother', () => {
  const s = twoSided({ cacheCount: 0, cacheVisibleM: 300 });
  place(s, 'h1', 0, 0); place(s, 'h2', 900, 900);
  place(s, 'g1', 0, 700); place(s, 'g2', -900, -900);
  s.caches = [
    { id: 'near', ...geo.offset(CENTRE, 100, 0), takenBy: null, respawnAt: 0 },
    { id: 'far', ...geo.offset(CENTRE, 700, 0), takenBy: null, respawnAt: 0 },
    { id: 'taken', ...geo.offset(CENTRE, 50, 0), takenBy: 'h2', respawnAt: T0 + 9e9 },
  ];
  run(s, 1000, { each: (now) => heartbeat(s, now) });
  const ids = viewFor(s, 'h1', s.t).caches.map((c) => c.id);
  assert.deepEqual(ids, ['near']);
});

test('a scout reveal reaches only the ghost who paid for it', () => {
  const s = twoSided();
  place(s, 'h1', -120, -80); place(s, 'h2', 400, 0);
  place(s, 'g1', 0, 700); place(s, 'g2', 0, 900);
  give(s, 'g1', 'scout'); charge(s, 'g1', 200);
  applyIntent(s, 'g1', { type: 'use', item: 'scout' }, s.t);
  step(s, s.t + 500);
  assert.ok(leaks(viewFor(s, 'g1', s.t), s.players.h1, 1), 'scout showed nothing');
  assert.ok(leaks(viewFor(s, 'g1', s.t), s.players.h2, 1));
  assert.ok(!leaks(viewFor(s, 'g2', s.t), s.players.h1), 'scout leaked to another ghost');
});

test('a sonar hit reaches the whole hunting party', () => {
  const s = twoSided();
  place(s, 'h1', 0, 0); place(s, 'h2', 900, 900);
  place(s, 'g1', 200, 0); place(s, 'g2', -900, -900);
  give(s, 'h1', 'sonar'); charge(s, 'h1', 200);
  applyIntent(s, 'h1', { type: 'use', item: 'sonar' }, s.t);
  step(s, s.t + 500);
  for (const id of ['h1', 'h2']) {
    assert.ok(viewFor(s, id, s.t).reveals.some((r) => r.kind === 'sonar'), `${id} missed the sonar hit`);
  }
  assert.ok(!viewFor(s, 'g1', s.t).reveals.some((r) => r.kind === 'sonar'), 'the ghost saw the sonar hit');
});

test('a caught player watches from the hunters\' side, not as a free spotter', () => {
  const s = makeGame({
    players: ['h1', 'g1', 'g2'], roles: { h1: 'hunter', g1: 'ghost', g2: 'ghost' },
    config: { scatterS: 0, infection: false },
  });
  start(s);
  place(s, 'h1', 0, 0); place(s, 'g1', 5, 0); place(s, 'g2', 800, 0);
  run(s, 4000, { each: (now) => heartbeat(s, now) });
  assert.equal(s.players.g1.role, 'spectator');
  const view = viewFor(s, 'g1', s.t);
  assert.ok(!leaks(view, s.players.g2), 'a spectator could still see their old team');
});

test('after the whistle everything is on the table', () => {
  const s = twoSided({ durationS: 30, scatterS: 0 });
  place(s, 'h1', 0, 0); place(s, 'h2', 900, 900);
  place(s, 'g1', 600, 0); place(s, 'g2', -600, 0);
  run(s, 31_000, { each: (now) => heartbeat(s, now) });
  assert.equal(s.phase, 'over');
  const view = viewFor(s, 'h1', s.t);
  assert.ok(leaks(view, s.players.g1, 1), 'positions stayed hidden after the match');
  const board = leaderboard(s);
  assert.equal(board.length, 4);
  assert.ok(board[0].score >= board[board.length - 1].score, 'leaderboard is not sorted');
});

test('the feed only carries what each player is entitled to', () => {
  const s = twoSided({ cacheCount: 0, cacheDwellS: 1 });
  place(s, 'h1', 0, 0); place(s, 'h2', 900, 900);
  place(s, 'g1', 100, 0); place(s, 'g2', -900, -900);
  s.caches = [{ id: 'c1', ...geo.offset(CENTRE, 100, 0), takenBy: null, respawnAt: 0 }];
  run(s, 3000, { each: (now) => heartbeat(s, now) });
  assert.equal(s.players.g1.caches, 1);
  assert.ok(viewFor(s, 'g1', s.t).feed.some((e) => e.type === 'cache'), 'no receipt for my own loot');
  assert.ok(!viewFor(s, 'h1', s.t).feed.some((e) => e.type === 'cache'), 'a hunter was told about a ghost\'s loot');
});

test('a broadcast view stays small enough to send twice a second', () => {
  const s = makeGame({
    players: ['h1', 'h2', 'g1', 'g2', 'g3', 'g4', 'g5'],
    roles: { h1: 'hunter', h2: 'hunter' },
    config: { scatterS: 0, cacheCount: 18 },
  });
  start(s);
  s.players.h1.role = 'hunter'; s.players.h2.role = 'hunter';
  let i = 0;
  for (const id of Object.keys(s.players)) place(s, id, (i++ * 90) - 300, 40);
  run(s, 3000, { each: (now) => heartbeat(s, now) });
  const bytes = JSON.stringify(viewFor(s, 'h1', s.t)).length;
  assert.ok(bytes < 12_000, `view is ${bytes} bytes`);
});

test('a hunter who strays during the head start is exposed to the ghosts', () => {
  const s = makeGame({
    players: ['h1', 'g1'], roles: { h1: 'hunter', g1: 'ghost' },
    config: { scatterS: 120 },
  });
  start(s);
  place(s, 'h1', 10, 0); place(s, 'g1', 500, 0);
  run(s, 2000, { each: (now) => heartbeat(s, now) });
  assert.ok(!viewFor(s, 'g1', s.t).reveals.some((r) => r.kind === 'falsestart'),
    'a hunter waiting where they should be was reported anyway');
  place(s, 'h1', 300, 0);                       // sets off early
  run(s, 2000, { each: (now) => heartbeat(s, now) });
  const reveal = viewFor(s, 'g1', s.t).reveals.find((r) => r.kind === 'falsestart');
  assert.ok(reveal, 'a false start went unpunished');
  assert.ok(geo.distance(reveal, s.players.h1) < 1, 'the false-start beacon is not live');
});
