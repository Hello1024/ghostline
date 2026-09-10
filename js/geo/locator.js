/**
 * Where you are.
 *
 * Two implementations behind one interface: the real GPS, and a simulated
 * walker for trying the game out indoors. The simulator is not a debug hack —
 * it is how you learn the interface before taking seven people outside.
 */

import * as geo from '../engine/geo.js';

/** @typedef {{lat:number, lon:number, acc:number, at:number}} Fix */

export function createGpsLocator({ onFix, onError }) {
  let watchId = null;
  let last = null;

  return {
    kind: 'gps',
    start() {
      if (!('geolocation' in navigator)) {
        onError?.(new Error('This device has no location services.'));
        return false;
      }
      watchId = navigator.geolocation.watchPosition(
        (pos) => {
          last = {
            lat: pos.coords.latitude,
            lon: pos.coords.longitude,
            acc: pos.coords.accuracy ?? 999,
            at: Date.now(),
          };
          onFix?.(last);
        },
        (err) => onError?.(err),
        { enableHighAccuracy: true, maximumAge: 2000, timeout: 15000 },
      );
      return true;
    },
    stop() {
      if (watchId != null) navigator.geolocation.clearWatch(watchId);
      watchId = null;
    },
    get last() { return last; },
  };
}

/**
 * A walker you steer with a thumbstick. Useful for practice, for testing the
 * interface at a desk, and for spectating without a signal.
 */
export function createSimLocator({ onFix, start, speed = 1.5 }) {
  let pos = { ...start };
  let heading = 0;
  let throttle = 0;
  let timer = null;
  let last = null;

  const emit = () => {
    last = { lat: pos.lat, lon: pos.lon, acc: 5, at: Date.now() };
    onFix?.(last);
  };

  return {
    kind: 'sim',
    /** @param {number} deg compass bearing @param {number} power 0..1 */
    steer(deg, power) {
      heading = deg;
      throttle = Math.max(0, Math.min(1, power));
    },
    stopMoving() { throttle = 0; },
    teleport(to) { pos = { ...to }; emit(); },
    start() {
      emit();
      timer = setInterval(() => {
        if (throttle > 0) {
          pos = geo.destination(pos, heading, speed * throttle * 0.25);
        }
        emit();
      }, 250);
      return true;
    },
    stop() { if (timer) clearInterval(timer); timer = null; },
    get last() { return last; },
    get position() { return pos; },
  };
}
