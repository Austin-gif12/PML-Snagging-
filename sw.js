// Offline support: keeps a copy of the app itself on the device so it opens with no signal.
// Jobs, snags, drawings and photos are cached separately by Firebase's offline mode.
// If you change the app and upload it, bump the version below so every phone picks up the new files.
const CACHE = 'pml-snagging-v1';
const FB = 'https://www.gstatic.com/firebasejs/10.13.2/';
const CORE = [
  './', './index.html', './firebase-init.js', './firebase-config.js', './manifest.webmanifest',
  './assets/logo-light.png', './assets/logo-dark-print.png', './assets/icon-180.png', './assets/icon-512.png'
];
const EXTRA = [
  FB + 'firebase-app.js', FB + 'firebase-auth.js', FB + 'firebase-firestore.js',
  'https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=DM+Mono:wght@400;500&family=Montserrat:wght@600;700;800&display=swap',
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js'
];
// Only these outside sites are cached. Firebase's own data connections are never touched.
const CACHE_HOSTS = ['www.gstatic.com', 'fonts.googleapis.com', 'fonts.gstatic.com', 'cdnjs.cloudflare.com'];

function fetchWithTimeout(req, ms) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  return fetch(req, { signal: ctl.signal }).finally(() => clearTimeout(t));
}

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    await c.addAll(CORE);
    await Promise.all(EXTRA.map(u =>
      fetchWithTimeout(u, 10000).then(res => { if (res.ok) return c.put(u, res); }).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;
  if (!sameOrigin && !CACHE_HOSTS.includes(url.hostname)) return; // Firebase data, sign-in etc. go straight to the network

  // App files: try the network briefly (so updates come through), else use the saved copy.
  if (sameOrigin) {
    e.respondWith((async () => {
      const c = await caches.open(CACHE);
      const key = req.mode === 'navigate' ? './index.html' : req;
      try {
        const res = await fetchWithTimeout(req, 4000);
        if (res.ok) c.put(key, res.clone());
        return res;
      } catch {
        return (await c.match(key, { ignoreSearch: true })) || (await c.match('./index.html')) || Response.error();
      }
    })());
    return;
  }

  // Libraries and fonts: saved copy first, network if missing.
  e.respondWith((async () => {
    const c = await caches.open(CACHE);
    const hit = await c.match(req);
    if (hit) return hit;
    try {
      const res = await fetch(req);
      if (res.ok || res.type === 'opaque') c.put(req, res.clone());
      return res;
    } catch { return Response.error(); }
  })());
});
