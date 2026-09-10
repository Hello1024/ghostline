/**
 * The session layer, driven through the loopback transport: seven clients, a
 * host, and all the awkward things that happen to phones outdoors — sleeping,
 * dropping off the network, coming back, and sending rubbish.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHost } from '../js/net/host.js';
import { createClient } from '../js/net/client.js';
import { createLocalPair } from '../js/net/transport-local.js';
import { encode, MSG } from '../js/net/protocol.js';
import { createGame } from '../js/engine/state.js';
import * as geo from '../js/engine/geo.js';
import { T0, CENTRE } from './_util.mjs';

function session({ players = 7, config = {} } = {}) {
  let now = T0;
  const clock = () => now;
  const state = createGame({
    seed: 'net', area: CENTRE, now, hostId: 'p0', code: 'NETT',
    config: { durationS: 1800, scatterS: 30, ...config },
  });
  const link = createLocalPair();
  const events = [];
  const host = createHost({
    transport: link.host, state, localPlayerId: 'p0', localName: 'Host', clock,
    onEvent: (e) => events.push(e),
  });
  const clients = [];
  for (let i = 1; i < players; i++) {
    const id = `p${i}`;
    const t = link.connect(`peer-${id}`);
    const c = createClient({ transport: t, playerId: id, name: `Player${i}`, clock });
    c.transport = t;
    c.hello();
    clients.push(c);
  }
  return {
    state, host, clients, link, events,
    advance(ms, stepMs = 250) {
      for (let done = 0; done < ms; done += stepMs) {
        now += stepMs;
        host.tick(now);
      }
      return now;
    },
    at: () => now,
    setNow: (v) => { now = v; },
  };
}

test('everyone who says hello gets a seat and a view', () => {
  const s = session({ players: 7 });
  assert.equal(Object.keys(s.state.players).length, 7);
  assert.ok(s.clients.every((c) => c.welcomed), 'a client never got a welcome');
  assert.ok(s.clients.every((c) => c.view), 'a client never got a view');
  assert.equal(s.host.connectedPlayers.length, 6);
});

test('intents travel and the host is the one that decides', () => {
  const s = session();
  const c = s.clients[0];
  const pos = geo.offset(CENTRE, 120, 40);
  c.send({ type: 'fix', lat: pos.lat, lon: pos.lon, acc: 5, at: s.at() });
  assert.ok(geo.distance(s.state.players.p1, pos) < 1, 'the fix never landed');
  // A non-host cannot start the match, however nicely it asks.
  c.send({ type: 'start' });
  assert.equal(s.state.phase, 'lobby');
  s.host.localIntent({ type: 'setRole', target: 'p1', role: 'hunter' });
  s.host.localIntent({ type: 'start' });
  assert.equal(s.state.phase, 'scatter');
});

test('each client is sent only its own view', () => {
  const s = session();
  s.host.localIntent({ type: 'setRole', target: 'p1', role: 'hunter' });
  s.host.localIntent({ type: 'setRole', target: 'p0', role: 'hunter' });
  s.host.localIntent({ type: 'start' });
  // Spread everyone out.
  s.host.localIntent({ type: 'fix', ...geo.offset(CENTRE, 0, 0), acc: 5, at: s.at() });
  s.clients.forEach((c, i) => {
    const p = geo.offset(CENTRE, 300 + i * 90, 200);
    c.send({ type: 'fix', lat: p.lat, lon: p.lon, acc: 5, at: s.at() });
  });
  s.advance(1000);
  const hunterView = s.clients[0].view;      // p1 is a hunter
  const ghostView = s.clients[1].view;       // p2 is a ghost
  assert.equal(hunterView.me.id, 'p1');
  assert.equal(ghostView.me.id, 'p2');
  const ghostRow = hunterView.players.find((p) => p.id === 'p3');
  assert.equal(ghostRow.lat, undefined, 'a hunter was sent a ghost position over the wire');
  assert.ok(JSON.stringify(hunterView) !== JSON.stringify(ghostView), 'everyone got the same view');
});

test('dropping off the network counts as going dark', () => {
  const s = session();
  s.host.localIntent({ type: 'setRole', target: 'p1', role: 'hunter' });
  s.host.localIntent({ type: 'start' });
  for (const c of s.clients) c.send({ type: 'fix', ...geo.offset(CENTRE, 200, 0), acc: 5, at: s.at() });
  s.link.host.disconnect('peer-p2');
  assert.equal(s.state.players.p2.connected, false);
  s.advance(30_000);
  assert.ok(s.state.players.p2.dark.totalMs > 10_000, 'a vanished player paid nothing');
  assert.equal(s.host.connectedPlayers.includes('p2'), false);
});

test('a player can come back on a new connection and reclaim their game', () => {
  const s = session();
  s.host.localIntent({ type: 'setRole', target: 'p1', role: 'hunter' });
  s.host.localIntent({ type: 'start' });
  s.clients[1].send({ type: 'fix', ...geo.offset(CENTRE, 250, 0), acc: 5, at: s.at() });
  s.advance(5000);
  const scoreBefore = s.state.players.p2.score;
  const itemsBefore = s.state.players.p2.items.length;

  s.link.host.disconnect('peer-p2');
  s.advance(20_000);

  // Same player id, brand new connection — a phone that rebooted.
  const t = s.link.connect('peer-p2-again');
  const back = createClient({ transport: t, playerId: 'p2', name: 'Player2', clock: s.at });
  back.hello();
  assert.ok(back.welcomed, 'the returning player was turned away');
  assert.equal(s.state.players.p2.connected, true);
  assert.equal(s.state.players.p2.items.length, itemsBefore);
  assert.ok(s.state.players.p2.score >= scoreBefore, 'progress was lost on reconnect');
  assert.equal(Object.keys(s.state.players).length, 7, 'a duplicate player was created');
  assert.ok(s.events.some((e) => e.type === 'rejoin'));
});

test('a second device claiming the same player retires the first', () => {
  const s = session();
  const t = s.link.connect('peer-p3-other');
  const impostor = createClient({ transport: t, playerId: 'p3', name: 'Player3', clock: s.at });
  impostor.hello();
  assert.equal(s.host.peerFor('p3'), 'peer-p3-other');
  assert.equal(Object.keys(s.state.players).length, 7);
});

test('rubbish on the wire is dropped without disturbing the game', () => {
  const s = session();
  const before = JSON.stringify(s.state);
  const peer = 'peer-p1';
  for (const junk of ['', '{{{', 'null', '[]', JSON.stringify({ t: 'view', view: 'no' }),
    JSON.stringify({ t: 'intent', i: { type: 'evil' } }), 'x'.repeat(70_000),
    JSON.stringify({ t: 'hello', playerId: '../../root' })]) {
    s.link.hub.hostHandlers.onMessage(peer, junk);
  }
  assert.equal(JSON.stringify(s.state), before, 'junk changed the world');
  assert.ok(s.events.some((e) => e.type === 'bad-message'));
});

test('intents are refused until a client introduces itself', () => {
  const s = session();
  const t = s.link.connect('peer-stranger');
  let lastError = null;
  t.on({ onMessage: (raw) => { const m = JSON.parse(raw); if (m.t === MSG.ERROR) lastError = m.error; } });
  t.send(encode({ t: MSG.INTENT, i: { type: 'fix', lat: 51.5, lon: -0.12, acc: 5, at: T0 } }));
  assert.equal(lastError, 'say-hello-first');
});

test('the host keeps ticking with nobody connected at all', () => {
  const s = session({ players: 1 });
  s.host.localIntent({ type: 'fix', ...geo.offset(CENTRE, 0, 0), acc: 5, at: s.at() });
  assert.doesNotThrow(() => s.advance(10_000));
  assert.equal(s.state.phase, 'lobby');
});

test('clients learn the host clock through ping and pong', () => {
  const s = session({ players: 2 });
  const c = s.clients[0];
  c.ping();
  assert.ok(Number.isFinite(c.rtt), 'no round trip measured');
  assert.ok(Math.abs(c.hostNow() - s.at()) < 50, 'clock estimate is way off');
});

test('a full lobby turns away the next arrival', () => {
  const s = session({ players: 1, config: { maxPlayers: 3 } });
  const errors = [];
  for (let i = 1; i <= 5; i++) {
    const t = s.link.connect(`peer-x${i}`);
    // Listen through the client, since it installs its own message handler.
    createClient({
      transport: t, playerId: `x${i}`, name: `X${i}`, clock: s.at,
      onEvent: (e) => { if (e.type === 'error') errors.push(e.error); },
    }).hello();
  }
  assert.ok(Object.keys(s.state.players).length <= 3, 'the cap did not hold');
  assert.ok(errors.includes('game-full'));
});
