/**
 * Ghostline — application wiring.
 *
 * Screens, sessions, and the loop that pushes your position to the host and
 * paints whatever it sends back. Nothing here decides anything about the game:
 * the rules live in js/engine and the host is the only authority.
 */

import { createGame, addPlayer, assignRoles } from './engine/state.js';
import { applyIntent } from './engine/engine.js';
import { viewFor, leaderboard } from './engine/view.js';
import { mkRng, lobbyCode } from './engine/rng.js';
import { CONFIG_SCHEMA, ROLE } from './engine/constants.js';
import { ITEMS } from './engine/items.js';
import * as geo from './engine/geo.js';
import { createHost } from './net/host.js';
import { createClient } from './net/client.js';
import { createLocalPair } from './net/transport-local.js';
import { createRelayHost, createRelayClient, relayUrl, saveRelayUrl, relayHealth, defaultRelay } from './net/transport-ws.js';
import { createGpsLocator, createSimLocator } from './geo/locator.js';
import { createPresence } from './geo/presence.js';
import { createGameMap } from './ui/map.js';
import { createAreaPicker, describeArea } from './ui/areapicker.js';
import { createHud, renderScoreboard, escapeHtml, mmss } from './ui/hud.js';
import { newBrain, decide, walk } from './bots/bot.js';

/* global qrcode */

const el = (id) => document.getElementById(id);
const LONDON = { lat: 51.5074, lon: -0.1278 };

const app = {
  screen: 'home',
  mode: null,            // 'host' | 'client' | 'practice'
  session: null,
  state: null,
  view: null,
  map: null,
  hud: null,
  locator: null,
  presence: null,
  bots: new Map(),
  picker: null,
  pickFor: null,
  loop: null,
  areaRing: null,          // the play area, as a ring of {lat, lon}
};

// ------------------------------------------------------------- identity --

function playerId() {
  let id = localStorage.getItem('ghostline.pid');
  if (!id || !/^[A-Za-z0-9_-]{6,64}$/.test(id)) {
    id = 'p' + Math.random().toString(36).slice(2, 12) + Date.now().toString(36).slice(-4);
    localStorage.setItem('ghostline.pid', id);
  }
  return id;
}
const rememberName = (n) => localStorage.setItem('ghostline.name', n);
const savedName = () => localStorage.getItem('ghostline.name') || '';

// -------------------------------------------------------------- screens --

function show(name) {
  app.screen = name;
  for (const s of document.querySelectorAll('.screen')) s.hidden = s.dataset.screen !== name;
  if (name === 'game') requestAnimationFrame(() => app.map?.invalidate());
  if (name === 'create') requestAnimationFrame(() => app.picker?.invalidate());
}

let toastTimer = null;
function toast(msg, ms = 2600) {
  const t = el('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

function buzz(pattern) {
  try { navigator.vibrate?.(pattern); } catch { /* not supported, never mind */ }
}

// ----------------------------------------------------------- area picker --

function setupPicker() {
  if (app.picker) { app.picker.invalidate(); return; }

  app.picker = createAreaPicker(el('picker-map'), {
    onChange: (info) => {
      app.areaRing = info.ring;
      const readout = el('area-readout');
      const size = describeArea(info.areaM2);
      if (info.problem) {
        readout.className = 'readout bad';
        readout.textContent = {
          'area-too-small': `Too small to hide in — ${size}. Make it bigger.`,
          'area-too-big': `Too big to walk — ${size}. Make it smaller.`,
          'area-crosses-itself': 'The boundary crosses itself. Move a corner.',
          'too-many-corners': 'That is too many corners.',
          'bad-area': 'Tap the map to place at least three corners.',
        }[info.problem] || 'That shape will not work.';
      } else {
        readout.className = 'readout';
        readout.textContent = `${size} · ${info.corners} corners · ${(info.perimeterM / 1000).toFixed(2)} km to walk round`;
      }
      el('btn-open-lobby').disabled = !!info.problem;
    },
  });
  requestAnimationFrame(() => app.picker.invalidate());

  el('area-size').addEventListener('input', (e) => {
    const size = Number(e.target.value);
    el('area-label').textContent = `${(size / 1609.34).toFixed(1)} miles`;
    app.picker.setSize(size);
  });
  el('btn-undo-corner').addEventListener('click', () => app.picker.undo());
  el('btn-reset-square').addEventListener('click', () => {
    app.picker.resetToSquare();
    toast('Back to a square');
  });

  el('btn-locate').addEventListener('click', () => {
    if (!navigator.geolocation) return toast('No location services on this device.');
    toast('Finding you…');
    navigator.geolocation.getCurrentPosition(
      (pos) => app.picker.centreOn(pos.coords.latitude, pos.coords.longitude, 15),
      () => toast('Could not get a fix. Pan the map instead.'),
      { enableHighAccuracy: true, timeout: 10000 },
    );
  });

  const bind = (id, labelId, fmt) => {
    const input = el(id);
    const update = () => { el(labelId).textContent = fmt(Number(input.value)); };
    input.addEventListener('input', update);
    update();
  };
  bind('duration', 'dur-label', (v) => `${Math.round(v / 60)} min`);
  bind('scatter', 'scatter-label', (v) => (v ? `${Math.round(v / 60)} min` : 'none'));
  bind('pulse', 'pulse-label', (v) => `${v}s`);
  bind('hunters', 'hunters-label', (v) => String(v));
}

/** The ring to play on, falling back to a default square. */
function playArea() {
  return app.areaRing?.length >= 3
    ? app.areaRing
    : geo.squarePolygon(LONDON, 1609);
}

function chosenConfig() {
  return {
    durationS: Number(el('duration').value),
    scatterS: Number(el('scatter').value),
    pingIntervalS: Number(el('pulse').value),
    areaSizeM: Number(el('area-size').value),
    infection: el('infection').checked,
  };
}

// -------------------------------------------------------------- sessions --

/** Wrap host or client behind one small interface the rest of the app uses. */
function hostSession(host) {
  return {
    isHost: true,
    host,
    send: (intent) => host.localIntent(intent),
    get view() { return host.localView(); },
    get state() { return host.state; },
    close: () => host.close(),
  };
}
function clientSession(client) {
  return {
    isHost: false,
    client,
    send: (intent) => client.send(intent),
    get view() { return client.view; },
    get state() { return null; },
    close: () => client.close(),
  };
}

async function startHosting() {
  const name = el('host-name').value.trim() || 'Host';
  rememberName(name);
  const seedRng = mkRng({ rngState: (Date.now() ^ Math.floor(Math.random() * 1e9)) >>> 0 });
  const code = lobbyCode(seedRng);
  const state = createGame({
    seed: `${code}-${Date.now()}`,
    area: { polygon: playArea() },
    config: chosenConfig(),
    hostId: playerId(),
    code,
  });
  el('create-err').textContent = '';
  let transport;
  try {
    transport = await createRelayHost(code, { playerId: playerId(), onStatus: (msg) => toast(msg) });
  } catch (err) {
    el('create-err').textContent = `Could not reach the relay: ${err.message} Practice mode works without it.`;
    return;
  }
  const host = createHost({
    transport, state, localPlayerId: playerId(), localName: name,
    onChange: renderLobby,
    onEvent: (e) => {
      if (e.type === 'join') toast(`${e.name} joined`);
      if (e.type === 'rejoin') toast(`${e.name} reconnected`);
    },
  });
  host.start();
  app.mode = 'host';
  app.session = hostSession(host);
  app.state = state;
  openLobby(code);
}

async function joinGame() {
  const code = el('join-code').value.trim().toUpperCase();
  const name = el('join-name').value.trim() || 'Player';
  rememberName(name);
  if (!/^[A-Z0-9]{4}$/.test(code)) {
    el('join-err').textContent = 'A lobby code is four characters.';
    return;
  }
  el('join-err').textContent = '';
  let transport;
  try {
    transport = await createRelayClient(code, {
      playerId: playerId(),
      onStatus: (msg) => toast(msg),
      onLink: (up) => { if (!up) toast('Connection dropped — reconnecting…'); },
    });
  } catch (err) {
    el('join-err').textContent = `Could not connect: ${err.message}`;
    return;
  }
  const client = createClient({
    transport, playerId: playerId(), name,
    onView: (view) => { app.view = view; onViewArrived(view); },
    onEvent: (e) => {
      if (e.type === 'error') toast(e.error.replace(/-/g, ' '));
      if (e.type === 'closed') toast('Lost the host — reconnecting…');
      if (e.type === 'welcome') toast('Connected');
    },
  });
  client.start();
  app.mode = 'client';
  app.session = clientSession(client);
  openLobby(code);
}

/** Practice: a whole game, bots and all, running inside this one phone. */
function startPractice() {
  const name = savedName() || 'You';
  const code = 'SOLO';
  const state = createGame({
    seed: `solo-${Date.now()}`,
    area: { polygon: playArea() },
    config: { ...chosenConfig(), scatterS: 60, durationS: 900 },
    hostId: playerId(),
    code,
  });
  const link = createLocalPair();
  const host = createHost({
    transport: link.host, state, localPlayerId: playerId(), localName: name,
    onChange: renderLobby,
  });
  for (let i = 1; i <= 6; i++) {
    addPlayer(state, { id: `bot${i}`, name: `Bot ${i}` });
    app.bots.set(`bot${i}`, newBrain(`bot${i}`));
  }
  assignRoles(state, 2);
  app.mode = 'practice';
  app.session = hostSession(host);
  app.state = state;
  openLobby(code);
  toast('Practice: you and six bots. Use the thumbstick to walk.');
}

// ---------------------------------------------------------------- lobby --

function openLobby(code) {
  el('lobby-code').textContent = code;
  const qr = el('qr');
  qr.innerHTML = '';
  if (app.mode !== 'practice') {
    try {
      const link = `${location.origin}${location.pathname}?join=${code}`;
      const q = qrcode(0, 'M');
      q.addData(link);
      q.make();
      qr.innerHTML = q.createImgTag(5, 8);
    } catch { qr.textContent = ''; }
  }
  el('host-controls').hidden = !(app.session?.isHost);
  el('btn-share').hidden = app.mode === 'practice';
  document.querySelector('.code-card').classList.toggle('practice', app.mode === 'practice');
  if (app.mode === 'practice') el('lobby-code').textContent = 'PRACTICE';
  show('lobby');
  renderLobby();
}

/**
 * Keep the roster playable. A fresh lobby is all ghosts, which the engine
 * rightly refuses to start, so pick hunters as soon as there are two people
 * — and never let a shuffle or a departure leave a side empty.
 */
function ensureRolesAssigned(force = false) {
  const state = app.state;
  if (!state || !app.session?.isHost || state.phase !== 'lobby') return false;
  const roster = Object.values(state.players).filter((p) => p.role !== ROLE.SPECTATOR);
  if (roster.length < 2) return false;
  const hunters = roster.filter((p) => p.role === ROLE.HUNTER).length;
  if (!force && hunters > 0 && hunters < roster.length) return false;
  const wanted = Math.max(1, Math.min(roster.length - 1, Number(el('hunters')?.value) || 2));
  assignRoles(state, wanted);
  app.session.host?.broadcastViews();
  return true;
}

function renderLobby() {
  if (app.screen !== 'lobby') return;
  ensureRolesAssigned();
  const view = app.session?.view;
  const players = view?.players ?? [];
  el('lobby-roster').innerHTML = players.map((p) => `
    <li>
      <span class="who">${escapeHtml(p.name)}</span>
      ${p.id === playerId() ? '<span class="me">you</span>' : ''}
      <span class="tag ${p.role}">${p.role}</span>
      ${p.connected ? '' : '<span class="tag off">away</span>'}
    </li>`).join('');
  const n = players.length;
  el('lobby-status').textContent = app.session?.isHost
    ? `${n} in the lobby. Everyone should be standing together before you start.`
    : `${n} in the lobby. Waiting for the host.`;
  el('lobby-hint').textContent = app.session?.isHost
    ? 'Roles are assigned at random when you start. Shuffle to re-roll them.'
    : '';
  el('btn-start').disabled = n < 2;

  if (view && (view.phase !== 'lobby' && view.phase !== 'over')) enterGame();
}

// ----------------------------------------------------------------- game --

function enterGame() {
  if (app.screen === 'game') return;
  show('game');
  if (!app.map) {
    app.map = createGameMap(el('game-map'), el('overlay'), {
      onPick: (latlon) => {
        if (!app.pickFor) return;
        app.session.send({ type: 'use', item: app.pickFor, params: latlon });
        app.pickFor = null;
        app.map.setPickMode(false);
        toast('Drone away');
      },
    });
    app.hud = createHud({
      phase: el('hud-phase'), clock: el('hud-clock'), pulse: el('hud-pulse'),
      chargeFill: el('charge-fill'), chargeLabel: el('charge-label'),
      items: el('hud-items'), alert: el('hud-alert'), feed: el('hud-feed'),
    }, { onUseItem: useItem });
  }
  app.map.invalidate();
  startSensors();
  if (!app.loop) app.loop = setInterval(frame, 250);
}

function useItem(id) {
  const item = ITEMS[id];
  if (!item) return;
  if (id === 'drone') {
    app.pickFor = id;
    app.map.setPickMode(true);
    toast('Tap the map to send the drone (up to 600m).');
    return;
  }
  const r = app.session.send({ type: 'use', item: id });
  if (r && r.ok === false) toast(String(r.error).replace(/-/g, ' '));
  else buzz(30);
}

let lastProximity = 'none';
function onViewArrived(view) {
  // For a guest this is the only heartbeat there is: the lobby, and the moment
  // the match starts, both arrive as views pushed by the host.
  if (app.screen === 'lobby') renderLobby();
  // A cue you can feel through a pocket — the one thing the screen can't do.
  if (view.proximity.level !== lastProximity && view.phase !== 'scatter') {
    if (view.proximity.level === 'contact') buzz([60, 40, 60, 40, 120]);
    else if (view.proximity.level === 'near') buzz([40, 60, 40]);
    lastProximity = view.proximity.level;
  }
  if (view.phase === 'over' && app.screen === 'game') showResults(view);
}

function frame() {
  if (app.mode === 'practice' || app.mode === 'host') runBots();
  const view = app.session?.view;
  if (!view) return;
  const changed = app.view?.phase !== view.phase;
  app.view = view;
  if (app.screen === 'lobby') { renderLobby(); return; }
  if (app.screen !== 'game') return;
  app.map.draw(view);
  app.hud.render(view, view.t);
  if (changed && view.phase === 'collapse') { toast('The square is closing in'); buzz([100, 50, 100]); }
  if (view.phase === 'over') showResults(view);
}

/** Bots think on the host's device, from the same view a person would get. */
function runBots() {
  const state = app.state;
  if (!state || !app.bots.size) return;
  const now = Date.now();
  const rng = mkRng(state);
  for (const [id, brain] of app.bots) {
    const p = state.players[id];
    if (!p) continue;
    if (p.lat == null) {
      const spawn = geo.jitter(state.start || state.area, 40, rng);
      applyIntent(state, id, { type: 'fix', lat: spawn.lat, lon: spawn.lon, acc: 6, at: now }, now);
      applyIntent(state, id, { type: 'presence', visible: true, wakeLock: true }, now);
      continue;
    }
    const view = viewFor(state, id, now);
    const plan = decide(view, brain, rng, now, 0.25);
    if (plan.use) applyIntent(state, id, { type: 'use', item: plan.use.item, params: plan.use.params }, now);
    const next = walk({ lat: p.lat, lon: p.lon }, plan.target, plan.speed, 0.25, rng);
    applyIntent(state, id, { type: 'fix', lat: next.lat, lon: next.lon, acc: 6, at: now }, now);
  }
}

function startSensors() {
  if (app.locator) return;
  const sim = app.mode === 'practice' || localStorage.getItem('ghostline.sim') === '1';
  const onFix = (fix) => app.session?.send({ type: 'fix', ...fix });

  if (sim) {
    const centre = app.state?.start || app.state?.area || { lat: LONDON.lat, lon: LONDON.lon };
    app.locator = createSimLocator({ onFix, start: geo.jitter(centre, 30, mkRng({ rngState: 1234 })) });
    setupStick(app.locator);
    el('sim-stick').hidden = false;
  } else {
    app.locator = createGpsLocator({
      onFix,
      onError: (err) => toast(err.code === 1
        ? 'Location permission refused — the game needs it.'
        : 'No GPS fix yet. Step outside if you can.'),
    });
  }
  app.locator.start();

  app.presence = createPresence({
    onChange: (s) => app.session?.send({ type: 'presence', visible: s.visible, wakeLock: s.wakeLock }),
  });
  app.presence.start().then(() => {
    if (!app.presence.supported) toast('This browser will not hold the screen awake — keep it on yourself.');
  });
}

/** The practice thumbstick. */
function setupStick(locator) {
  const stick = el('sim-stick');
  const knob = el('sim-knob');
  let active = null;
  const centre = () => {
    const r = stick.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, r: r.width / 2 };
  };
  const move = (e) => {
    if (active == null) return;
    // Touch events carry a list; a mouse event is its own coordinate source.
    const t = e.touches ? [...e.touches].find((x) => x.identifier === active) : e;
    if (!t) return;
    const c = centre();
    const dx = t.clientX - c.x;
    const dy = t.clientY - c.y;
    const dist = Math.min(c.r, Math.hypot(dx, dy));
    const deg = (Math.atan2(dx, -dy) * 180 / Math.PI + 360) % 360;
    locator.steer(deg, dist / c.r);
    knob.style.transform = `translate(${(dx / (Math.hypot(dx, dy) || 1)) * dist}px, ${(dy / (Math.hypot(dx, dy) || 1)) * dist}px)`;
    e.preventDefault();
  };
  const end = () => { active = null; locator.stopMoving(); knob.style.transform = ''; };
  const clamp = (v) => (Number.isFinite(v) ? v : 0);
  stick.addEventListener('touchstart', (e) => { active = e.changedTouches[0].identifier; move(e); }, { passive: false });
  stick.addEventListener('touchmove', move, { passive: false });
  stick.addEventListener('touchend', end);
  stick.addEventListener('touchcancel', end);
  stick.addEventListener('mousedown', (e) => { active = 'mouse'; const m = (ev) => move(ev); const up = () => { end(); window.removeEventListener('mousemove', m); window.removeEventListener('mouseup', up); }; window.addEventListener('mousemove', m); window.addEventListener('mouseup', up); move(e); });
}

// -------------------------------------------------------------- results --

function showResults(view) {
  if (app.screen === 'over') return;
  const board = app.state ? leaderboard(app.state) : rosterAsBoard(view);
  el('over-title').textContent = 'Match over';
  const mine = board.find((r) => r.id === playerId());
  const won = view.outcome === 'ghosts' ? 'The ghosts held out' : 'The hunters swept the board';
  el('over-outcome').innerHTML = `${won}${mine ? ` — you scored <b>${mine.score}</b>` : ''}`;
  renderScoreboard(el('over-board'), board, view);
  stopSensors();
  show('over');
  buzz([80, 60, 80]);
}

function rosterAsBoard(view) {
  return [...view.players]
    .map((p) => ({
      id: p.id, name: p.name, role: p.role, score: p.score,
      catches: p.catches, caches: p.caches, distanceM: 0, darkS: 0, jumps: 0,
    }))
    .sort((a, b) => b.score - a.score);
}

function stopSensors() {
  app.locator?.stop();
  app.presence?.stop();
  app.locator = null;
  app.presence = null;
  el('sim-stick').hidden = true;
}

function goHome() {
  stopSensors();
  clearInterval(app.loop);
  app.loop = null;
  try { app.session?.close(); } catch { /* already gone */ }
  app.session = null;
  app.state = null;
  app.view = null;
  app.bots.clear();
  app.mode = null;
  show('home');
}

// ----------------------------------------------------------------- boot --

function wire() {
  el('btn-create').addEventListener('click', () => { setupPicker(); el('host-name').value = savedName(); show('create'); });
  el('btn-join').addEventListener('click', () => { el('join-name').value = savedName(); show('join'); });
  el('btn-practice').addEventListener('click', () => { setupPicker(); startPractice(); });
  el('btn-rules').addEventListener('click', () => show('rules'));
  el('btn-net').addEventListener('click', () => show('net'));
  for (const b of document.querySelectorAll('[data-back]')) {
    b.addEventListener('click', () => (app.session ? goHome() : show('home')));
  }
  el('btn-open-lobby').addEventListener('click', () => { el('btn-open-lobby').disabled = true; startHosting().finally(() => { el('btn-open-lobby').disabled = false; }); });
  el('btn-do-join').addEventListener('click', () => { el('btn-do-join').disabled = true; joinGame().finally(() => { el('btn-do-join').disabled = false; }); });
  el('btn-home').addEventListener('click', goHome);

  el('btn-share').addEventListener('click', async () => {
    const code = el('lobby-code').textContent;
    const url = `${location.origin}${location.pathname}?join=${code}`;
    const text = `Join my game of Ghostline — code ${code}`;
    try {
      if (navigator.share) await navigator.share({ title: 'Ghostline', text, url });
      else { await navigator.clipboard.writeText(url); toast('Link copied'); }
    } catch { /* the user changed their mind */ }
  });

  el('btn-shuffle').addEventListener('click', () => {
    if (!ensureRolesAssigned(true)) return;
    renderLobby();
    toast('Roles re-rolled');
  });

  el('btn-start').addEventListener('click', () => {
    const me = app.state?.players[playerId()];
    if (app.state && !app.state.players[playerId()]?.lat && app.mode !== 'practice') {
      // Anchor the head start on wherever the host is standing.
      navigator.geolocation?.getCurrentPosition((pos) => {
        app.session.send({ type: 'fix', lat: pos.coords.latitude, lon: pos.coords.longitude, acc: pos.coords.accuracy, at: Date.now() });
        reallyStart();
      }, reallyStart, { enableHighAccuracy: true, timeout: 8000 });
    } else {
      reallyStart();
    }
  });

  el('btn-recentre').addEventListener('click', () => app.map?.recentre());
  el('btn-fitarea').addEventListener('click', () => {
    if (!app.view?.area) return;
    app.map?.fitArea(app.view.area);
    toast('The whole play area');
  });
  el('btn-menu').addEventListener('click', openMenu);
  el('sheet-close').addEventListener('click', () => { el('sheet').hidden = true; });

  wireNetScreen();

  const params = new URLSearchParams(location.search);
  const code = params.get('join');
  if (code) {
    el('join-code').value = code.toUpperCase().slice(0, 4);
    el('join-name').value = savedName();
    show('join');
  }
  el('home-note').textContent = location.protocol === 'https:' || location.hostname === 'localhost'
    ? ''
    : 'Location needs a secure connection — open this over https.';
}

function reallyStart() {
  ensureRolesAssigned();
  const r = app.session.send({ type: 'start' });
  if (r && r.ok === false) {
    toast(String(r.error).replace(/-/g, ' '));
    return;
  }
  app.session.host?.broadcastViews();
  enterGame();
  buzz([60, 40, 60]);
}

// ----------------------------------------------------------- connection --

function wireNetScreen() {
  el('relay-url').value = relayUrl();
  el('relay-url').placeholder = defaultRelay();
  el('btn-save-relay').addEventListener('click', () => {
    const url = el('relay-url').value.trim();
    if (url && !/^wss?:\/\//i.test(url)) {
      toast('A relay address starts with wss://');
      return;
    }
    saveRelayUrl(url === defaultRelay() ? null : url);
    el('relay-url').value = relayUrl();
    toast(url ? 'Relay saved' : 'Back to the default relay');
  });
  el('btn-reset-relay').addEventListener('click', () => {
    saveRelayUrl(null);
    el('relay-url').value = relayUrl();
    toast('Back to the default relay');
  });
  el('btn-test-relay').addEventListener('click', testRelay);
}

/**
 * "It won't connect" should be answerable from the car park, so the app asks
 * the relay directly and says what it found.
 */
async function testRelay() {
  const out = el('relay-result');
  out.hidden = false;
  out.textContent = 'Testing…';
  const url = relayUrl();
  const lines = [`Relay   ${url}`];
  const started = Date.now();
  try {
    const health = await relayHealth(url);
    lines.push(`Status  up — ${health.rooms} game${health.rooms === 1 ? '' : 's'} in progress`, `        answered in ${Date.now() - started}ms`);
  } catch (err) {
    lines.push(`Status  UNREACHABLE — ${err.message}`, '',
      'The relay is down or this network is blocking it.');
    out.textContent = lines.join('\n');
    return;
  }

  // The health check is an ordinary request; the game needs a live socket.
  lines.push('');
  try {
    await new Promise((resolve, reject) => {
      const probe = new WebSocket(`${url}?room=TEST&role=guest&id=probe-${Math.random().toString(36).slice(2, 8)}`);
      const timer = setTimeout(() => { probe.close(); reject(new Error('no reply within 10s')); }, 10000);
      probe.addEventListener('message', () => { clearTimeout(timer); probe.close(); resolve(); });
      probe.addEventListener('error', () => { clearTimeout(timer); reject(new Error('the socket was refused')); });
      probe.addEventListener('close', () => { clearTimeout(timer); reject(new Error('the socket closed immediately')); });
    });
    lines.push('Socket  open — this device can host and join games.');
  } catch (err) {
    lines.push(`Socket  BLOCKED — ${err.message}`, '',
      'Ordinary requests get through but WebSockets do not. Some corporate and',
      'public wifi does this. Mobile data usually works.');
  }
  out.textContent = lines.join('\n');
}

function openMenu() {
  const view = app.view;
  el('sheet-title').textContent = 'Match';
  el('sheet-body').innerHTML = view ? `
    <p>You are a <b class="${view.me.role}">${view.me.role}</b>.
       ${view.me.role === 'ghost' ? 'Stay free until the clock runs out.' : 'Find them all.'}</p>
    <p>Walked <b>${(view.me.distanceM / 1000).toFixed(2)} km</b> · loot <b>${view.me.caches}</b>
       · time in the dark <b>${Math.round(view.me.dark.totalMs / 1000)}s</b></p>
    <p class="footnote">${view.me.wakeLock ? 'The screen is being held awake.' : 'The screen is not being held awake — keep it on.'}</p>
    <p class="footnote" id="route-line">Checking the connection…</p>
  ` : '';
  el('sheet').hidden = false;
  describeConnection();
}

/** How this device is actually talking to the others, in the match menu. */
async function describeConnection() {
  const line = el('route-line');
  if (!line) return;
  try {
    if (app.mode === 'practice') { line.textContent = 'Practice match — nothing is going over a network.'; return; }
    const transport = app.session?.isHost ? app.session.host : null;
    if (transport) {
      const peers = app.session.host.connectedPlayers.length;
      line.textContent = `Hosting — ${peers} ${peers === 1 ? 'player' : 'players'} connected to this device.`;
      return;
    }
    const route = await app.session?.client?.transportRoute?.();
    line.textContent = route
      ? `Connection: ${route.route}${route.rttMs != null ? ` · ${route.rttMs}ms` : ''}`
      : 'Connection: unknown.';
  } catch {
    line.textContent = '';
  }
}

if ('serviceWorker' in navigator) {
  // If a worker was already in charge and a new one takes over, the page is
  // now running against files the new worker may have replaced. Reload once so
  // the whole app comes from one version — a half-updated app is how you end
  // up with a new page calling into modules that no longer exist.
  const hadController = !!navigator.serviceWorker.controller;
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || reloading) return;
    reloading = true;
    location.reload();
  });
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js')
      .then((reg) => reg.update().catch(() => {}))
      .catch(() => { /* offline support is a bonus, not a requirement */ });
  });
}

wire();
show(new URLSearchParams(location.search).get('join') ? 'join' : 'home');
