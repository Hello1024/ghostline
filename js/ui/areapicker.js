/**
 * Drawing the play area.
 *
 * The boundary has to survive being explained to six other people standing in
 * a car park, so it is drawn on the map itself: tap to place corners, drag them
 * to adjust, tap a corner to remove it. It starts as a square of the chosen
 * size because that is what most people want, and stops being a square the
 * moment you touch it.
 *
 * Everything is a real Leaflet layer rather than an element floating above the
 * map, which is what keeps it correctly stacked with the tiles.
 */

import * as geo from '../engine/geo.js';
import { polygonProblem } from '../engine/engine.js';

/* global L */

const TILES = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const ATTRIB = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

const SHAPE_STYLE = { color: '#37e2c8', weight: 3, fillColor: '#37e2c8', fillOpacity: 0.12 };
const BAD_STYLE = { color: '#ff4d6d', weight: 3, fillColor: '#ff4d6d', fillOpacity: 0.12 };

export function createAreaPicker(el, { onChange } = {}) {
  const map = L.map(el, { zoomControl: false, attributionControl: true, tap: false })
    .setView([51.5074, -0.1278], 15);
  L.tileLayer(TILES, { maxZoom: 19, attribution: ATTRIB }).addTo(map);

  let ring = [];
  let mode = 'square';        // 'square' follows the map and the slider
  let sizeM = 1609;
  let shape = null;
  let programmatic = false;   // suppresses the follow-the-centre handler
  let fitted = false;         // has the shape been framed at a real size yet?
  const handles = [];

  const corner = () => L.divIcon({
    className: 'corner-handle',
    iconSize: [26, 26],
    html: '<span></span>',
  });

  function redraw() {
    const problem = polygonProblem(ring);
    if (!shape) {
      shape = L.polygon(ring.map(toLatLng), SHAPE_STYLE).addTo(map);
    } else {
      shape.setLatLngs(ring.map(toLatLng));
    }
    shape.setStyle(problem ? BAD_STYLE : SHAPE_STYLE);

    // Handles are only worth showing on a shape you are editing by hand.
    while (handles.length > ring.length) handles.pop().remove();
    ring.forEach((p, i) => {
      if (handles[i]) {
        handles[i].setLatLng(toLatLng(p));
        return;
      }
      const m = L.marker(toLatLng(p), { icon: corner(), draggable: true, keyboard: false, zIndexOffset: 1000 })
        .addTo(map);
      m.on('drag', () => {
        const idx = handles.indexOf(m);
        const ll = m.getLatLng();
        ring[idx] = { lat: ll.lat, lon: ll.lng };
        mode = 'custom';
        redrawShapeOnly();
      });
      m.on('dragend', () => announce());
      m.on('click', (e) => {
        L.DomEvent.stop(e);
        removeCorner(handles.indexOf(m));
      });
      handles[i] = m;
    });
    announce();
  }

  function redrawShapeOnly() {
    if (!shape) return;
    shape.setLatLngs(ring.map(toLatLng));
    shape.setStyle(polygonProblem(ring) ? BAD_STYLE : SHAPE_STYLE);
  }

  function announce() {
    onChange?.({
      ring: ring.map((p) => ({ ...p })),
      mode,
      areaM2: geo.polygonArea(ring),
      perimeterM: geo.polygonPerimeter(ring),
      corners: ring.length,
      problem: polygonProblem(ring),
    });
  }

  function squareHere() {
    const c = map.getCenter();
    ring = geo.squarePolygon({ lat: c.lat, lon: c.lng }, sizeM);
    redraw();
  }

  function removeCorner(index) {
    if (index < 0) return;
    if (ring.length <= 3) return;   // three corners is the least a shape can be
    ring.splice(index, 1);
    handles.splice(index, 1).forEach((m) => m.remove());
    mode = 'custom';
    redraw();
  }

  /** Insert a new corner where it disturbs the outline least. */
  function addCorner(p) {
    if (ring.length < 3) {
      ring.push(p);
      redraw();
      return;
    }
    let bestAt = ring.length;
    let bestCost = Infinity;
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % ring.length];
      // Detour cost: how much longer the perimeter gets by going via p.
      const cost = geo.distance(a, p) + geo.distance(p, b) - geo.distance(a, b);
      if (cost < bestCost) { bestCost = cost; bestAt = i + 1; }
    }
    ring.splice(bestAt, 0, p);
    redraw();
  }

  /**
   * Frame the whole shape. Marked programmatic so it does not feed back into
   * the follow-the-centre handler.
   *
   * Leaflet computes the zoom from the container's size, so fitting before the
   * screen has been laid out picks a zoom for a container of nothing and
   * leaves the area overflowing the map. `fitted` records whether that has
   * happened for real yet.
   */
  function fit() {
    if (ring.length < 3) return false;
    const size = map.getSize();
    if (size.x < 60 || size.y < 60) return false;
    const b = geo.polygonBounds(ring);
    programmatic = true;
    map.fitBounds([[b.minLat, b.minLon], [b.maxLat, b.maxLon]], { padding: [34, 34], animate: false });
    fitted = true;
    return true;
  }

  map.on('click', (e) => {
    mode = 'custom';
    addCorner({ lat: e.latlng.lat, lon: e.latlng.lng });
  });
  map.on('moveend', () => {
    // Fitting the map moves it, which would otherwise re-centre the square on
    // the new centre and fit again, forever.
    if (programmatic) { programmatic = false; return; }
    if (mode === 'square') squareHere();
  });

  squareHere();
  fit();

  return {
    map,
    get ring() { return ring.map((p) => ({ ...p })); },
    get mode() { return mode; },
    setSize(metres) {
      sizeM = metres;
      if (mode !== 'square') return;
      squareHere();
      fit();
    },
    resetToSquare() {
      mode = 'square';
      squareHere();
      fit();
    },
    undo() {
      if (ring.length <= 3) return;
      removeCorner(ring.length - 1);
    },
    centreOn(lat, lon, zoom = 15) {
      map.setView([lat, lon], zoom);
      if (mode === 'square') { squareHere(); fit(); }
    },
    fit,
    invalidate() {
      map.invalidateSize();
      // First time the screen is actually on-screen, frame the area.
      if (!fitted) fit();
    },
  };
}

const toLatLng = (p) => [p.lat, p.lon];

/** Human-readable size, in the units people actually use for ground. */
export function describeArea(areaM2) {
  if (!areaM2) return '—';
  const km2 = areaM2 / 1e6;
  const miles2 = km2 / 2.58999;
  if (km2 < 0.1) return `${Math.round(areaM2 / 1000) / 10} ha`;
  return `${km2.toFixed(2)} km² · ${miles2.toFixed(2)} sq mi`;
}
