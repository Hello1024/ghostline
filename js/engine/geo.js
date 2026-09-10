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
