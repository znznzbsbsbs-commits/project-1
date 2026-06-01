const CACHE = 'liquid-messenger-v2';
const ASSETS = [
  '/', '/legal.html', '/styles.css', '/extensions.js', '/app.js', '/manifest.webmanifest',
  '/plugins/core-tools/manifest.json', '/plugins/core-tools/index.js',
  '/plugins/theme-pack/manifest.json', '/plugins/theme-pack/index.js',
  '/plugins/safe-mode-controller/manifest.json', '/plugins/safe-mode-controller/index.js',
];
self.addEventListener('install', event => event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS))));
self.addEventListener('activate', event => event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key))))));
self.addEventListener('fetch', event => { if (event.request.method === 'GET') event.respondWith(fetch(event.request).catch(() => caches.match(event.request))); });
