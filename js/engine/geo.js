/**
 * Geodesy for a one-mile playfield.
 *
 * Distances use the haversine formula (exact enough at any scale we care
 * about); local offsets use an equirectangular projection anchored on the
 * play area, which is accurate to well under a metre across a mile.
 */

const R = 6371008.8;            // IUGG mean Earth radius, metres
const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

export const METRES_PER_DEG_LAT = (Math.PI * R) / 180; // ~111319.5

export function metresPerDegLon(lat) {
  return METRES_PER_DEG_LAT * Math.cos(lat * D2R);
}

/** Great-circle distance in metres between two {lat, lon} points. */
export function distance(a, b) {
  if (!a || !b) return Infinity;
  const dLat = (b.lat - a.lat) * D2R;
  const dLon = (b.lon - a.lon) * D2R;
  const la1 = a.lat * D2R;
  const la2 = b.lat * D2R;
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Initial bearing from a to b, in degrees clockwise from north (0..360). */
export function bearing(a, b) {
  const la1 = a.lat * D2R;
  const la2 = b.lat * D2R;
  const dLon = (b.lon - a.lon) * D2R;
  const y = Math.sin(dLon) * Math.cos(la2);
  const x = Math.cos(la1) * Math.sin(la2) - Math.sin(la1) * Math.cos(la2) * Math.cos(dLon);
  return (Math.atan2(y, x) * R2D + 360) % 360;
}

/** Travel `dist` metres from `origin` along `brg` degrees. */
export function destination(origin, brg, dist) {
  const d = dist / R;
  const b = brg * D2R;
  const la1 = origin.lat * D2R;
  const lo1 = origin.lon * D2R;
  const la2 = Math.asin(Math.sin(la1) * Math.cos(d) + Math.cos(la1) * Math.sin(d) * Math.cos(b));
  const lo2 = lo1 + Math.atan2(
    Math.sin(b) * Math.sin(d) * Math.cos(la1),
    Math.cos(d) - Math.sin(la1) * Math.sin(la2),
  );
  return { lat: la2 * R2D, lon: (((lo2 * R2D) + 540) % 360) - 180 };
}

/** Offset a point by metres east and north. */
export function offset(origin, eastM, northM) {
  return {
    lat: origin.lat + northM / METRES_PER_DEG_LAT,
    lon: origin.lon + eastM / metresPerDegLon(origin.lat),
  };
}

/** Metres east/north of `origin`. Inverse of `offset`. */
export function toLocal(origin, p) {
  return {
    x: (p.lon - origin.lon) * metresPerDegLon(origin.lat),
    y: (p.lat - origin.lat) * METRES_PER_DEG_LAT,
  };
}

/** Axis-aligned square of side `sizeM` centred on `center`. */
export function squareBounds(center, sizeM) {
  const half = sizeM / 2;
  const dLat = half / METRES_PER_DEG_LAT;
  const dLon = half / metresPerDegLon(center.lat);
  return {
    minLat: center.lat - dLat,
    maxLat: center.lat + dLat,
    minLon: center.lon - dLon,
    maxLon: center.lon + dLon,
  };
}

export function inBounds(bounds, p) {
  return !!p && p.lat >= bounds.minLat && p.lat <= bounds.maxLat &&
    p.lon >= bounds.minLon && p.lon <= bounds.maxLon;
}

/** How far outside `bounds` a point is, in metres (0 when inside). */
export function distanceOutside(bounds, p) {
  if (!p) return 0;
  const lat = Math.max(bounds.minLat, Math.min(bounds.maxLat, p.lat));
  const lon = Math.max(bounds.minLon, Math.min(bounds.maxLon, p.lon));
  return distance(p, { lat, lon });
}

export function clampToBounds(bounds, p) {
  return {
    lat: Math.max(bounds.minLat, Math.min(bounds.maxLat, p.lat)),
    lon: Math.max(bounds.minLon, Math.min(bounds.maxLon, p.lon)),
  };
}

export function centerOf(bounds) {
  return { lat: (bounds.minLat + bounds.maxLat) / 2, lon: (bounds.minLon + bounds.maxLon) / 2 };
}

/** Uniform random point inside a bounds box. */
export function randomPointIn(bounds, rng) {
  return {
    lat: rng.range(bounds.minLat, bounds.maxLat),
    lon: rng.range(bounds.minLon, bounds.maxLon),
  };
}

/** A point uniformly distributed in the disc of radius `r` around `center`. */
export function jitter(center, r, rng) {
  const d = r * Math.sqrt(rng());
  return destination(center, rng() * 360, d);
}

/** Compass letters for a bearing — used by the tracker HUD. */
export function compassPoint(brg) {
  const names = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  return names[Math.round(((brg % 360) + 360) % 360 / 45) % 8];
}

// ---------------------------------------------------------------------------
// Polygons
//
// The play area is an arbitrary shape the host draws on the map, because real
// ground has rivers, main roads and railway lines through it and a square does
// not care. All of this works by projecting to metres about the polygon's own
// first vertex — exact enough over a few kilometres, and it turns every one of
// these into plain plane geometry.
// ---------------------------------------------------------------------------

/** Project a ring of {lat,lon} to metric x/y about its first vertex. */
function ringToLocal(poly) {
  const origin = poly[0];
  return poly.map((p) => toLocal(origin, p));
}

/** Signed area of a polygon in square metres (positive when anticlockwise). */
export function polygonSignedArea(poly) {
  if (!poly || poly.length < 3) return 0;
  const pts = ringToLocal(poly);
  let sum = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    sum += pts[j].x * pts[i].y - pts[i].x * pts[j].y;
  }
  return sum / 2;
}

export const polygonArea = (poly) => Math.abs(polygonSignedArea(poly));

/** Area-weighted centroid. Falls back to the mean for a degenerate ring. */
export function polygonCentroid(poly) {
  if (!poly || !poly.length) return null;
  if (poly.length < 3) {
    return {
      lat: poly.reduce((a, p) => a + p.lat, 0) / poly.length,
      lon: poly.reduce((a, p) => a + p.lon, 0) / poly.length,
    };
  }
  const origin = poly[0];
  const pts = ringToLocal(poly);
  let cx = 0; let cy = 0; let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const f = pts[j].x * pts[i].y - pts[i].x * pts[j].y;
    a += f;
    cx += (pts[j].x + pts[i].x) * f;
    cy += (pts[j].y + pts[i].y) * f;
  }
  if (Math.abs(a) < 1e-9) {
    return {
      lat: poly.reduce((s, p) => s + p.lat, 0) / poly.length,
      lon: poly.reduce((s, p) => s + p.lon, 0) / poly.length,
    };
  }
  a *= 3;
  return offset(origin, cx / a, cy / a);
}

/** Ray casting. Points exactly on an edge count as inside. */
export function pointInPolygon(poly, p) {
  if (!poly || poly.length < 3 || !p) return false;
  const origin = poly[0];
  const pts = ringToLocal(poly);
  const q = toLocal(origin, p);
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[j];
    const b = pts[i];
    if (segmentDistance(q, a, b) < 1e-6) return true;    // on the boundary
    const straddles = (b.y > q.y) !== (a.y > q.y);
    if (straddles && q.x < ((a.x - b.x) * (q.y - b.y)) / (a.y - b.y) + b.x) inside = !inside;
  }
  return inside;
}

/** Shortest distance from a point to a line segment, all in metres. */
function segmentDistance(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** How far outside the polygon a point is, in metres. Zero when inside. */
export function distanceOutsidePolygon(poly, p) {
  if (!poly || poly.length < 3 || !p) return 0;
  if (pointInPolygon(poly, p)) return 0;
  const origin = poly[0];
  const pts = ringToLocal(poly);
  const q = toLocal(origin, p);
  let best = Infinity;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    best = Math.min(best, segmentDistance(q, pts[j], pts[i]));
  }
  return best;
}

/** The nearest point on the polygon's boundary — where to walk back to. */
export function nearestPointOnPolygon(poly, p) {
  if (!poly || poly.length < 3 || !p) return null;
  const origin = poly[0];
  const pts = ringToLocal(poly);
  const q = toLocal(origin, p);
  let best = null;
  let bestD = Infinity;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[j];
    const b = pts[i];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    let t = len2 === 0 ? 0 : ((q.x - a.x) * dx + (q.y - a.y) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    const c = { x: a.x + t * dx, y: a.y + t * dy };
    const d = Math.hypot(q.x - c.x, q.y - c.y);
    if (d < bestD) { bestD = d; best = c; }
  }
  return best ? offset(origin, best.x, best.y) : null;
}

export function polygonBounds(poly) {
  const b = { minLat: Infinity, maxLat: -Infinity, minLon: Infinity, maxLon: -Infinity };
  for (const p of poly || []) {
    b.minLat = Math.min(b.minLat, p.lat);
    b.maxLat = Math.max(b.maxLat, p.lat);
    b.minLon = Math.min(b.minLon, p.lon);
    b.maxLon = Math.max(b.maxLon, p.lon);
  }
  return b;
}

/** Shrink or grow a polygon about a fixed point — how the zone collapses. */
export function scalePolygon(poly, k, about = null) {
  if (!poly || poly.length < 3) return poly ? poly.slice() : poly;
  const centre = about || polygonCentroid(poly);
  return poly.map((p) => {
    const l = toLocal(centre, p);
    return offset(centre, l.x * k, l.y * k);
  });
}

/**
 * A uniform random point inside the polygon.
 *
 * Rejection sampling over the bounding box. A pathologically thin shape could
 * in principle exhaust the attempts, so it falls back to the centroid rather
 * than spinning — a cache in a slightly odd place beats a hung host.
 */
export function randomPointInPolygon(poly, rng, attempts = 200) {
  const b = polygonBounds(poly);
  for (let i = 0; i < attempts; i++) {
    const p = { lat: rng.range(b.minLat, b.maxLat), lon: rng.range(b.minLon, b.maxLon) };
    if (pointInPolygon(poly, p)) return p;
  }
  return polygonCentroid(poly);
}

/** The default shape: an axis-aligned square, which the host can then edit. */
export function squarePolygon(centre, sizeM) {
  const h = sizeM / 2;
  return [
    offset(centre, -h, h),
    offset(centre, h, h),
    offset(centre, h, -h),
    offset(centre, -h, -h),
  ];
}

/** A regular n-gon, offered as a starting shape for irregular ground. */
export function regularPolygon(centre, sizeM, sides = 6) {
  const r = sizeM / 2;
  const out = [];
  for (let i = 0; i < sides; i++) out.push(destination(centre, (360 / sides) * i, r));
  return out;
}

/** Total edge length in metres — used to sanity-check a drawn shape. */
export function polygonPerimeter(poly) {
  if (!poly || poly.length < 2) return 0;
  let sum = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) sum += distance(poly[j], poly[i]);
  return sum;
}

/** Does the ring cross itself? A bow-tie play area is not a play area. */
export function isSimplePolygon(poly) {
  if (!poly || poly.length < 3) return false;
  const pts = ringToLocal(poly);
  const n = pts.length;
  const cross = (a, b, c) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  const touches = (p, a, b) => segmentDistance(p, a, b) < 1e-6;
  const intersects = (a, b, c, d) => {
    const d1 = cross(c, d, a);
    const d2 = cross(c, d, b);
    const d3 = cross(a, b, c);
    const d4 = cross(a, b, d);
    if (((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0))) return true;
    return touches(a, c, d) || touches(b, c, d) || touches(c, a, b) || touches(d, a, b);
  };
  for (let i = 0; i < n; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    for (let j = i + 1; j < n; j++) {
      if (j === i || (j + 1) % n === i || j === (i + 1) % n) continue;
      const c = pts[j];
      const d = pts[(j + 1) % n];
      if (intersects(a, b, c, d)) return false;
    }
  }
  return true;
}
