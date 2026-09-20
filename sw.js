// sw.js — Service Worker for RIDE
// Strategy:
//  - App shell (HTML/CSS/JS/manifest/icon): cache-first, so the game boots instantly offline.
//  - Third-party CDN modules (three.js, cannon-es) and remote .glb assets: stale-while-revalidate,
//    so the game still plays offline after the first successful load, but picks up updates quietly.

const SHELL_CACHE = 'ride-shell-v1';
const RUNTIME_CACHE = 'ride-runtime-v1';

const SHELL_FILES = [
  './',
  './index.html',
  './style.css',
  './manifest.json',
  './icon.svg',
  './main.js',
  './game.js',
  './physics.js',
  './ui.js',
  './audio.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL_FILES))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== SHELL_CACHE && key !== RUNTIME_CACHE)
          .map((key) => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  const isSameOrigin = url.origin === self.location.origin;

  if (isSameOrigin) {
    // App shell: cache-first, falling back to network, then re-caching.
    event.respondWith(
      caches.match(request).then((cached) => {
        if (cached) return cached;
        return fetch(request).then((response) => {
          const copy = response.clone();
          caches.open(SHELL_CACHE).then((cache) => cache.put(request, copy));
          return response;
        }).catch(() => cached);
      })
    );
  } else {
    // CDN libraries + remote GLB models: stale-while-revalidate.
    event.respondWith(
      caches.open(RUNTIME_CACHE).then((cache) =>
        cache.match(request).then((cached) => {
          const networkFetch = fetch(request)
            .then((response) => {
              if (response && response.status === 200) {
                cache.put(request, response.clone());
              }
              return response;
            })
            .catch(() => cached);
          return cached || networkFetch;
        })
      )
    );
  }
});
