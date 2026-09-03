/*
 * sw.js — offline shell.
 *
 * The phone must already hold this app before it goes near the probe: opening
 * the probe's provisioning AP takes the handset off the network, and a paddy
 * field may have no data connection at all. So the shell is cache-first and the
 * whole app is precached on install — it is a few kilobytes.
 *
 * Bump CACHE when any precached file changes, or clients keep the old one.
 */

const CACHE = 'npk-probe-v3';

const SHELL = [
  './',
  'index.html',
  'app.css',
  'app.js',
  'npk-ble.js',
  'manifest.webmanifest',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE)
      .then(cache => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;   // fonts, anything third-party

  event.respondWith(
    caches.match(request).then(hit => {
      if (hit) {
        // Serve from cache, then quietly refresh it for next time. A failed
        // refresh is the normal offline case and must not surface as an error.
        event.waitUntil(
          fetch(request)
            .then(response => {
              if (response && response.ok) return caches.open(CACHE).then(c => c.put(request, response));
            })
            .catch(() => {})
        );
        return hit;
      }

      return fetch(request).catch(() => {
        // A navigation that missed the cache still gets the app rather than the
        // browser's offline page.
        if (request.mode === 'navigate') return caches.match('index.html');
        return Response.error();
      });
    })
  );
});
