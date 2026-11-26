const cachePrefix = 'plotter-facil-app-';
const cacheName = cachePrefix + '2';
const assets = [
  './', './manifest.webmanifest', './install.js', './style.css?v=6', './app.mjs?v=8',
  './engine.mjs?v=6', './engine.mjs', './contour.mjs', './plotter-logo.png',
  './icon-192.png', './icon-512.png', './vendor/pdf-lib.js', './vendor/clipper.js',
  './vendor/pdf.mjs', './vendor/pdf.worker.mjs',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(cacheName).then((cache) => cache.addAll(assets)));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(
    keys.filter((key) => key.startsWith(cachePrefix) && key !== cacheName)
      .map((key) => caches.delete(key))
  )));
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET' || !request.url.startsWith(self.registration.scope)) return;

  event.respondWith((async () => {
    try {
      return await fetch(request);
    } catch {
      const cache = await caches.open(cacheName);
      const saved = await cache.match(request);
      if (saved) return saved;
      if (request.mode === 'navigate') {
        const home = await cache.match(self.registration.scope);
        if (home) return home;
      }
      return Response.error();
    }
  })());
});
