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

const VERSION = 'ghostline-v3';
const SHELL = `${VERSION}-shell`;
const TILES = `${VERSION}-tiles`;
const MAX_TILES = 600;

/**
 * Files that make up the running app. These are fetched from the network
 * first, every load, and only fall back to the cache when the network is
 * genuinely unavailable.
 *
 * That is deliberate, and it is the second attempt. The first version served
 * these from the cache and refreshed in the background, which meant an updated
 * page could load against stale modules — new index.html, old main.js — and
 * the app simply broke. The usual fix is to bump a version string in this file
 * so the worker reinstalls, but this project has no build step, so an ordinary
 * deploy leaves sw.js byte-identical and no reinstall ever happens. Freshness
 * therefore cannot depend on anyone remembering to edit this file.
 *
 * Falling back only on a real network failure is what keeps it consistent: if
 * one file comes from the cache, they all do, and the cache only ever holds a
 * single install's worth of files.
 */
const SHELL_PATTERN = /\.(?:html|js|mjs|css|webmanifest)$/i;

/** Big, stable, and safe to serve from the cache: vendored libraries and icons. */
const IMMUTABLE_PATTERN = /^\/?(?:vendor|icons)\//i;

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
  './js/net/transport-ws.js',
  './js/geo/locator.js',
  './js/geo/presence.js',
  './js/ui/hud.js',
  './js/ui/map.js',
  './js/ui/areapicker.js',
  './js/bots/bot.js',
  './vendor/leaflet/leaflet.js',
  './vendor/leaflet/leaflet.css',
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

  // The relay and anything else off-origin must never be served from a cache.
  if (url.origin !== self.location.origin) return;

  const path = url.pathname.replace(self.location.pathname.replace(/[^/]*$/, ''), '/');
  if (IMMUTABLE_PATTERN.test(path)) {
    event.respondWith(cacheFirst(request, event));
    return;
  }

  const isShell = request.mode === 'navigate'
    || SHELL_PATTERN.test(url.pathname)
    || url.pathname.endsWith('/');
  event.respondWith(isShell ? networkFirst(request) : cacheFirst(request, event));
});

/**
 * Network first. `no-cache` revalidates with the server rather than trusting a
 * max-age, so a 304 is cheap and a changed file is never missed.
 */
async function networkFirst(request) {
  try {
    const fresh = await fetch(new Request(request.url, {
      cache: 'no-cache',
      credentials: 'same-origin',
      redirect: 'follow',
    }));
    if (fresh && fresh.ok) {
      const copy = fresh.clone();
      caches.open(SHELL).then((c) => c.put(request, copy)).catch(() => {});
      return fresh;
    }
    // A 404 or 500 is a real answer; do not paper over it with a stale file.
    if (fresh && fresh.status >= 400 && fresh.status < 500) return fresh;
  } catch {
    // Offline. Everything below comes from one install, so it stays consistent.
  }
  const cached = await caches.match(request, { ignoreSearch: true });
  if (cached) return cached;
  if (request.mode === 'navigate') {
    const shell = await caches.match('./index.html', { ignoreSearch: true });
    if (shell) return shell;
  }
  return new Response('Offline and not cached.', { status: 503, headers: { 'content-type': 'text/plain' } });
}

/** Cache first, for things that do not change without changing their name. */
async function cacheFirst(request, event) {
  const cached = await caches.match(request, { ignoreSearch: false });
  if (cached) {
    event.waitUntil(refresh(request));
    return cached;
  }
  try {
    const fresh = await fetch(request);
    if (fresh && fresh.ok) {
      const copy = fresh.clone();
      caches.open(SHELL).then((c) => c.put(request, copy)).catch(() => {});
    }
    return fresh;
  } catch {
    return new Response('Offline and not cached.', { status: 503, headers: { 'content-type': 'text/plain' } });
  }
}

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
