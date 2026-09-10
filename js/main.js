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
import { createPeerHost, createPeerClient } from './net/transport-peer.js';
import { createGpsLocator, createSimLocator } from './geo/locator.js';
import { createPresence } from './geo/presence.js';
import { createGameMap, createPickerMap } from './ui/map.js';
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
  area: { ...LONDON, sizeM: 1609 },
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
  if (name === 'create') requestAnimationFrame(() => app.picker?.invalidateSize());
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
  if (app.picker) return;
  app.picker = createPickerMap(el('picker-map'));
  const redraw = () => {
    const size = Number(el('area-size').value);
    const centre = app.picker.getCenter();
    app.area = { lat: centre.lat, lon: centre.lng, sizeM: size };
    // Show the square at true scale by measuring it in screen pixels.
    const b = geo.squareBounds(app.area, size);
    const tl = app.picker.latLngToContainerPoint([b.maxLat, b.minLon]);
    const br = app.picker.latLngToContainerPoint([b.minLat, b.maxLon]);
    const box = el('picker-box');
    box.style.width = `${Math.max(8, br.x - tl.x)}px`;
    box.style.height = `${Math.max(8, br.y - tl.y)}px`;
    el('area-label').textContent = `${(size / 1609.34).toFixed(1)} miles`;
  };
  app.picker.on('move zoom resize', redraw);
  el('area-size').addEventListener('input', redraw);
  requestAnimationFrame(() => { app.picker.invalidateSize(); redraw(); });

  el('btn-locate').addEventListener('click', () => {
    if (!navigator.geolocation) return toast('No location services on this device.');
    toast('Finding you…');
    navigator.geolocation.getCurrentPosition(
      (pos) => { app.picker.setView([pos.coords.latitude, pos.coords.longitude], 15); redraw(); },
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
    area: app.area,
    config: { ...chosenConfig(), areaSizeM: app.area.sizeM },
    hostId: playerId(),
    code,
  });
  el('create-err').textContent = '';
  let transport;
  try {
    transport = await createPeerHost(code, { onStatus: (s) => toast(s) });
  } catch (err) {
    el('create-err').textContent = `Could not reach the matchmaking server: ${err.message}. Practice mode works offline.`;
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
    transport = await createPeerClient(code, { onStatus: (s) => toast(s) });
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
    area: app.area.lat ? app.area : { ...LONDON, sizeM: 1609 },
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

function renderLobby() {
  if (app.screen !== 'lobby') return;
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
    const centre = app.state?.start || app.state?.area || app.area;
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
    if (!app.state) return;
    assignRoles(app.state, Number(el('hunters').value) || 2);
    app.session.host.broadcastViews();
    renderLobby();
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
  el('btn-menu').addEventListener('click', openMenu);
  el('sheet-close').addEventListener('click', () => { el('sheet').hidden = true; });

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
  const r = app.session.send({ type: 'start' });
  if (r && r.ok === false) {
    toast(String(r.error).replace(/-/g, ' '));
    return;
  }
  app.session.host?.broadcastViews();
  enterGame();
  buzz([60, 40, 60]);
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
  ` : '';
  el('sheet').hidden = false;
}

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => { /* offline support is a bonus */ });
  });
}

wire();
show(new URLSearchParams(location.search).get('join') ? 'join' : 'home');
