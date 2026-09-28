// Offline support: keeps a copy of the app on the device so it opens with no signal.
// Your jobs, drawings, snags and photos are stored separately on the device (IndexedDB), not here.
// When you upload a changed index.html, the next time the app is opened with signal it picks up the new version.
const CACHE = 'pml-snagging-v1';
const CORE = [
  './',
  './index.html',
  './manifest.webmanifest',
  './assets/logo-light.png',
  './assets/logo-dark-print.png',
  './assets/icon-180.png',
  './assets/icon-512.png'
];
// Fonts and the PDF reader come from other sites; cache them if we can, but don't fail without them.
const EXTRA = [
  'https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=DM+Mono:wght@400;500&family=Montserrat:wght@600;700;800&display=swap',
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js'
];

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    await c.addAll(CORE);
    await Promise.all(EXTRA.map(u =>
      fetchWithTimeout(u, 8000).then(res => { if (res.ok) return c.put(u, res); }).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

// Try the network briefly so updates come through, otherwise use the saved copy.
function fetchWithTimeout(req, ms) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  return fetch(req, { signal: ctl.signal }).finally(() => clearTimeout(t));
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;

  // The app page itself: network first (4s), fall back to the cached copy.
  if (req.mode === 'navigate') {
    e.respondWith((async () => {
      const c = await caches.open(CACHE);
      try {
        const res = await fetchWithTimeout(req, 4000);
        if (res.ok) c.put('./index.html', res.clone());
        return res;
      } catch {
        return (await c.match('./index.html')) || (await c.match('./')) || Response.error();
      }
    })());
    return;
  }

  // Everything else (logos, fonts, PDF reader): use the cached copy straight away,
  // and refresh it in the background when online.
  e.respondWith((async () => {
    const c = await caches.open(CACHE);
    const hit = await c.match(req);
    const net = fetch(req).then(res => {
      if (res.ok || res.type === 'opaque') c.put(req, res.clone());
      return res;
    }).catch(() => null);
    if (hit) { e.waitUntil(net); return hit; }
    const res = await net;
    return res || Response.error();
  })());
});
