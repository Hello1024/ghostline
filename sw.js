/**
 * Service worker.
 *
 * Two jobs. First, the app shell is precached so the game opens instantly and
 * survives the patchy signal you get halfway down a side street. Second, map
 * tiles you have already walked past are kept in a bounded cache, so
 * backtracking does not blank the map.
 *
 * The game itself needs the network — it is peer-to-peer and live — so this is
 * about resilience, not offline play.
 */

const VERSION = 'ghostline-v1';
const SHELL = `${VERSION}-shell`;
const TILES = `${VERSION}-tiles`;
const MAX_TILES = 600;

const PRECACHE = [
  './',
  './index.html',
  './app.webmanifest',
  './css/app.css',
  './js/main.js',
  './js/engine/constants.js',
  './js/engine/engine.js',
  './js/engine/geo.js',
  './js/engine/items.js',
  './js/engine/rng.js',
  './js/engine/state.js',
  './js/engine/view.js',
  './js/net/client.js',
  './js/net/host.js',
  './js/net/protocol.js',
  './js/net/transport-local.js',
  './js/net/transport-peer.js',
  './js/geo/locator.js',
  './js/geo/presence.js',
  './js/ui/hud.js',
  './js/ui/map.js',
  './js/bots/bot.js',
  './vendor/leaflet/leaflet.js',
  './vendor/leaflet/leaflet.css',
  './vendor/peerjs.min.js',
  './vendor/qrcode.js',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    // One bad URL should not stop the whole install.
    await Promise.all(PRECACHE.map((url) => cache.add(url).catch(() => {})));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  // Map tiles: serve what we have, quietly refresh in the background.
  if (/tile\.openstreetmap\.org$/.test(url.hostname)) {
    event.respondWith(tile(request));
    return;
  }

  // Signalling and peer traffic must never be served from a cache.
  if (url.origin !== self.location.origin) return;

  event.respondWith((async () => {
    const cached = await caches.match(request, { ignoreSearch: url.pathname.endsWith('.html') || url.pathname === '/' });
    if (cached) {
      // Refresh in the background so the next launch is current.
      event.waitUntil(refresh(request));
      return cached;
    }
    try {
      return await fetch(request);
    } catch {
      const shell = await caches.match('./index.html');
      if (shell && request.mode === 'navigate') return shell;
      throw new Error('offline');
    }
  })());
});

async function refresh(request) {
  try {
    const fresh = await fetch(request);
    if (fresh && fresh.ok) (await caches.open(SHELL)).put(request, fresh.clone());
  } catch { /* still offline, keep what we have */ }
}

async function tile(request) {
  const cache = await caches.open(TILES);
  const hit = await cache.match(request);
  if (hit) return hit;
  try {
    const res = await fetch(request);
    if (res && res.ok) {
      cache.put(request, res.clone());
      trimTiles(cache);
    }
    return res;
  } catch {
    return hit || Response.error();
  }
}

/** Keep the tile cache from growing without limit on a long walk. */
async function trimTiles(cache) {
  const keys = await cache.keys();
  if (keys.length <= MAX_TILES) return;
  for (const key of keys.slice(0, keys.length - MAX_TILES)) await cache.delete(key);
}
