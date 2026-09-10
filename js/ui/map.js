/**
 * The map.
 *
 * Leaflet handles tiles, panning and zoom; everything to do with the game is
 * drawn on a canvas above it. That keeps redraws cheap while a dozen live
 * things move at once, and it means the game layer can look like a game rather
 * than like a set of map pins.
 */

import * as geo from '../engine/geo.js';

/* global L */

const ROLE_COLOUR = { ghost: '#a98bff', hunter: '#ff9f43', spectator: '#94a0b8' };
const REVEAL_COLOUR = {
  pulse: '#ffd166', sonar: '#ff9f43', drone: '#37e2c8', dragnet: '#ff9f43',
  trap: '#ff9f43', dark: '#ff4d6d', flag: '#ff4d6d', oob: '#ff4d6d',
  falsestart: '#ffd166', scout: '#a98bff',
};

const TILES = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const ATTRIB = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

export function createGameMap(mapEl, canvasEl, { onPick } = {}) {
  const map = L.map(mapEl, {
    zoomControl: false,
    attributionControl: true,
    preferCanvas: true,
    tap: false,
  }).setView([51.5074, -0.1278], 16);

  L.tileLayer(TILES, { maxZoom: 19, attribution: ATTRIB, crossOrigin: true }).addTo(map);

  const ctx = canvasEl.getContext('2d');
  let latest = null;
  let following = true;
  let pickMode = false;
  let frame = null;

  function resize() {
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    const rect = mapEl.getBoundingClientRect();
    canvasEl.width = Math.round(rect.width * dpr);
    canvasEl.height = Math.round(rect.height * dpr);
    canvasEl.style.width = `${rect.width}px`;
    canvasEl.style.height = `${rect.height}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    schedule();
  }

  const schedule = () => {
    if (frame) return;
    frame = requestAnimationFrame(() => { frame = null; render(); });
  };

  map.on('move zoom resize', schedule);
  map.on('movestart', () => { if (!pickMode) following = false; });
  map.on('click', (e) => { if (pickMode) onPick?.({ lat: e.latlng.lat, lon: e.latlng.lng }); });
  window.addEventListener('resize', resize);
  resize();

  const pt = (p) => map.latLngToContainerPoint([p.lat, p.lon]);

  /** Metres converted to screen pixels at the current zoom. */
  function metresToPixels(metres, at) {
    const a = pt(at);
    const b = pt(geo.destination(at, 90, metres));
    return Math.abs(b.x - a.x);
  }

  /** Trace a lat/lon ring onto the canvas as a closed path. */
  function ringPath(poly) {
    if (!poly || poly.length < 3) return false;
    ctx.beginPath();
    poly.forEach((p, i) => {
      const q = pt(p);
      if (i === 0) ctx.moveTo(q.x, q.y);
      else ctx.lineTo(q.x, q.y);
    });
    ctx.closePath();
    return true;
  }

  function render() {
    const view = latest;
    const w = canvasEl.clientWidth;
    const h = canvasEl.clientHeight;
    ctx.clearRect(0, 0, w, h);
    if (!view) return;

    const now = view.t;

    // --- the ground: the full area, and the live zone inside it -----------
    const areaRing = view.area?.polygon;
    const zoneRing = view.zone?.polygon;

    if (zoneRing?.length >= 3) {
      // Everything outside the live zone is off limits: wash it out. The
      // even-odd rule punches the playable shape out of a full-screen fill,
      // which works for any polygon, concave ones included.
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, w, h);
      zoneRing.forEach((p, i) => {
        const q = pt(p);
        if (i === 0) ctx.moveTo(q.x, q.y);
        else ctx.lineTo(q.x, q.y);
      });
      ctx.closePath();
      ctx.fillStyle = 'rgba(255,77,109,.10)';
      ctx.fill('evenodd');
      ctx.restore();
    }

    // The original area, once the zone has shrunk away from it.
    if (areaRing?.length >= 3 && view.zone?.scale < 0.999 && ringPath(areaRing)) {
      ctx.setLineDash([6, 6]);
      ctx.strokeStyle = 'rgba(148,160,184,.5)';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.setLineDash([]);
    }

    if (ringPath(zoneRing)) {
      ctx.strokeStyle = '#37e2c8';
      ctx.lineWidth = 2.5;
      ctx.stroke();
    }

    // --- caches -----------------------------------------------------------
    for (const c of view.caches) {
      const p = pt(c);
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(Math.PI / 4);
      ctx.fillStyle = '#37e2c8';
      ctx.globalAlpha = 0.9;
      ctx.fillRect(-6, -6, 12, 12);
      ctx.restore();
    }

    // --- drones -----------------------------------------------------------
    for (const d of view.drones) {
      const p = pt(d);
      const r = metresToPixels(d.radius, d);
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(55,226,200,.75)';
      ctx.setLineDash([4, 4]);
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // --- traps ------------------------------------------------------------
    for (const t of view.traps) {
      const p = pt(t);
      const armed = now >= t.armedAt;
      ctx.strokeStyle = armed ? '#ff9f43' : 'rgba(255,159,67,.4)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(p.x - 6, p.y - 6); ctx.lineTo(p.x + 6, p.y + 6);
      ctx.moveTo(p.x + 6, p.y - 6); ctx.lineTo(p.x - 6, p.y + 6);
      ctx.stroke();
    }

    // --- reveals: the whole point of the hunt -----------------------------
    for (const r of view.reveals) {
      if (r.lat == null) continue;
      const p = pt(r);
      const colour = REVEAL_COLOUR[r.kind] || '#ffd166';
      const fade = Math.max(0.25, Math.min(1, (r.until - now) / 6000));
      if (r.blur > 0) {
        const px = metresToPixels(r.blur, r);
        const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, Math.max(px, 6));
        g.addColorStop(0, hexA(colour, 0.34 * fade));
        g.addColorStop(1, hexA(colour, 0));
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(p.x, p.y, Math.max(px, 6), 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = hexA(colour, 0.65 * fade);
        ctx.lineWidth = 1.5;
        ctx.stroke();
      } else {
        ctx.beginPath();
        ctx.arc(p.x, p.y, 9, 0, Math.PI * 2);
        ctx.fillStyle = hexA(colour, 0.9 * fade);
        ctx.fill();
      }
      // A running ghost leaks which way they went.
      if (r.heading != null) arrow(p, r.heading, colour, Math.max(26, metresToPixels(r.blur, r) * 0.6));
    }

    // --- people -----------------------------------------------------------
    for (const row of view.players) {
      if (row.lat == null || row.id === view.me.id) continue;
      const p = pt(row);
      const colour = ROLE_COLOUR[row.role] || '#94a0b8';
      ctx.beginPath();
      ctx.arc(p.x, p.y, 8, 0, Math.PI * 2);
      ctx.fillStyle = colour;
      ctx.fill();
      ctx.strokeStyle = 'rgba(8,10,15,.9)';
      ctx.lineWidth = 2;
      ctx.stroke();
      label(p, row.name, colour);
    }

    // --- me ---------------------------------------------------------------
    const me = view.me;
    if (me.lat != null) {
      const p = pt(me);
      if (me.acc) {
        const r = metresToPixels(Math.min(me.acc, 120), me);
        ctx.beginPath();
        ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(55,226,200,.10)';
        ctx.fill();
      }
      if (me.heading != null && me.speed > 0.3) arrow(p, me.heading, '#37e2c8', 26);
      ctx.beginPath();
      ctx.arc(p.x, p.y, 10, 0, Math.PI * 2);
      ctx.fillStyle = ROLE_COLOUR[me.role] || '#37e2c8';
      ctx.fill();
      ctx.lineWidth = 3;
      ctx.strokeStyle = '#e8edf7';
      ctx.stroke();

      // Bloodhound points; it never says how far.
      if (view.bearing) {
        arrow(p, view.bearing.deg, '#ff9f43', 54, 5);
      }
    }
  }

  function arrow(p, deg, colour, length, width = 3) {
    const rad = (deg - 90) * Math.PI / 180;
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(rad);
    ctx.strokeStyle = colour;
    ctx.fillStyle = colour;
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(length, 0);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(length + 8, 0);
    ctx.lineTo(length - 4, -6);
    ctx.lineTo(length - 4, 6);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  function label(p, text, colour) {
    ctx.font = '600 11px ui-sans-serif, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(8,10,15,.85)';
    ctx.strokeText(text, p.x, p.y - 14);
    ctx.fillStyle = colour;
    ctx.fillText(text, p.x, p.y - 14);
  }

  return {
    map,
    /** Hand it a fresh fog-of-war view. */
    draw(view) {
      latest = view;
      if (following && view?.me?.lat != null) {
        map.setView([view.me.lat, view.me.lon], map.getZoom(), { animate: false });
      }
      schedule();
    },
    fitArea(area) {
      const ring = area?.polygon;
      if (!ring || ring.length < 3) return;
      const b = geo.polygonBounds(ring);
      map.fitBounds([[b.minLat, b.minLon], [b.maxLat, b.maxLon]], { animate: false, padding: [24, 24] });
      following = false;
    },
    recentre() {
      following = true;
      if (latest?.me?.lat != null) map.setView([latest.me.lat, latest.me.lon], 17, { animate: true });
    },
    get following() { return following; },
    setPickMode(on) {
      pickMode = on;
      mapEl.style.cursor = on ? 'crosshair' : '';
    },
    invalidate() { map.invalidateSize(); resize(); },
    destroy() { window.removeEventListener('resize', resize); map.remove(); },
  };
}

/** '#rrggbb' plus an alpha, as a CSS colour. */
function hexA(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/** A plain Leaflet map for choosing the play area. */
export function createPickerMap(el) {
  const map = L.map(el, { zoomControl: false, attributionControl: true, tap: false })
    .setView([51.5074, -0.1278], 15);
  L.tileLayer(TILES, { maxZoom: 19, attribution: ATTRIB }).addTo(map);
  return map;
}
