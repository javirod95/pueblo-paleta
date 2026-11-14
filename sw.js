/* Pueblo Paleta — service worker. Sube VERSION al cambiar cualquier archivo de la app. */
const VERSION = 'pp-v1.0.0';
const SHELL = [
  './', './index.html', './styles.css', './app.js', './config.js', './manifest.webmanifest',
  './assets/pueblo-paleta.png', './assets/icon-180.png', './assets/icon-192.png', './assets/icon-512.png'
];

self.addEventListener('install', e => e.waitUntil(
  caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())
));
self.addEventListener('activate', e => e.waitUntil(
  caches.keys().then(ks => Promise.all(ks.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim())
));

// La app (mismo origen) se sirve desde caché y se actualiza en segundo plano.
// Las llamadas a Supabase (otro origen) van siempre a la red.
self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  event.respondWith(caches.open(VERSION).then(cache =>
    cache.match(req, { ignoreSearch: true }).then(cached => {
      const net = fetch(req).then(resp => { if (resp.ok) cache.put(req, resp.clone()); return resp; }).catch(() => cached);
      return cached || net;
    })
  ));
});
