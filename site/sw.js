const VERSION = 'v1';
const CACHE = `reader-${VERSION}`;
const SHELL = ['./', 'index.html', 'app.css', 'app.js', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'icon-180.png', 'book/meta.json'];

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    await c.addAll(SHELL);
    try {
      const meta = await (await c.match('book/meta.json')).json();
      const files = meta.sections.map((s) => 'book/' + s.file).concat(['book/img/cover.jpg', 'book/img/title.jpg', 'book/img/ornament.png']);
      await c.addAll(files);
    } catch (err) { /* book caching is best-effort */ }
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (url.origin !== location.origin) {
    // fonts: cache as they arrive
    e.respondWith((async () => {
      const cached = await caches.match(e.request);
      if (cached) return cached;
      try {
        const res = await fetch(e.request);
        if (res.ok && (url.hostname.endsWith('gstatic.com') || url.hostname.endsWith('googleapis.com'))) {
          (await caches.open(CACHE)).put(e.request, res.clone());
        }
        return res;
      } catch (err) { return cached || Response.error(); }
    })());
    return;
  }
  e.respondWith((async () => {
    const cached = await caches.match(e.request, { ignoreSearch: true });
    const network = fetch(e.request).then(async (res) => {
      if (res.ok) (await caches.open(CACHE)).put(e.request, res.clone());
      return res;
    }).catch(() => null);
    if (cached) { network.catch(() => {}); return cached; }
    const res = await network;
    return res || new Response('Offline', { status: 503 });
  })());
});
