/**
 * Is this player actually looking at the game?
 *
 * The blackout rule needs an honest answer to that, and it needs it from a
 * device the player controls — so this reports what it can (visibility, focus,
 * whether the screen is being held awake) and the host independently treats
 * silence as absence. A client that lies about being awake still has to keep
 * talking, and a client that keeps talking is a client that is running.
 */

export function createPresence({ onChange }) {
  let wakeLock = null;
  let wakeLockHeld = false;
  let released = false;

  const state = () => ({
    visible: document.visibilityState === 'visible' && !released,
    wakeLock: wakeLockHeld,
  });

  const announce = () => onChange?.(state());

  async function requestWakeLock() {
    if (!('wakeLock' in navigator)) return false;
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLockHeld = true;
      wakeLock.addEventListener('release', () => {
        wakeLockHeld = false;
        announce();
      });
      announce();
      return true;
    } catch {
      wakeLockHeld = false;
      return false;
    }
  }

  function onVisibility() {
    if (document.visibilityState === 'visible') {
      // Chrome drops the lock whenever the page is hidden; take it again.
      requestWakeLock();
    }
    announce();
  }

  return {
    async start() {
      document.addEventListener('visibilitychange', onVisibility);
      window.addEventListener('pagehide', announce);
      window.addEventListener('pageshow', onVisibility);
      window.addEventListener('blur', announce);
      window.addEventListener('focus', announce);
      await requestWakeLock();
      announce();
    },
    stop() {
      released = true;
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', announce);
      window.removeEventListener('pageshow', onVisibility);
      window.removeEventListener('blur', announce);
      window.removeEventListener('focus', announce);
      try { wakeLock?.release(); } catch { /* already gone */ }
      wakeLock = null;
      wakeLockHeld = false;
    },
    get state() { return state(); },
    get supported() { return 'wakeLock' in navigator; },
  };
}
