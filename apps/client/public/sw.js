/* Must stay in sync with apps/client/src/sw-policy.ts. Tests lock both path rules. */
const CACHE = `veo-shell-${new URL(self.location.href).searchParams.get('v') || 'veo-pwa-1'}`;

function shouldCache(rawUrl, origin, contentType = '') {
  if (String(contentType).toLowerCase().includes('text/event-stream')) return false;
  let url;
  try {
    url = new URL(rawUrl, origin);
  } catch {
    return false;
  }
  if (url.origin !== origin) return false;
  if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return false;
  if (url.pathname.includes('/media/')) return false;
  if (url.searchParams.get('download') === '1') return false;
  if (url.pathname === '/' || url.pathname === '/index.html') return true;
  if (url.pathname.startsWith('/icons/')) return true;
  if (url.pathname.endsWith('.webmanifest')) return true;
  if (url.pathname.endsWith('.html') || url.pathname.endsWith('.js') || url.pathname.endsWith('.css')) return true;
  return false;
}

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(['/', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png'])));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(Promise.all([
    caches.keys().then((keys) => Promise.all(keys.filter((key) => key.startsWith('veo-shell-') && key !== CACHE).map((key) => caches.delete(key)))),
    self.clients.claim(),
  ]));
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const origin = self.location.origin;
  if (!shouldCache(request.url, origin, request.headers.get('accept') || '')) return;
  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const response = await fetch(request, { signal: AbortSignal.timeout(4000) });
        const copy = response.clone();
        const cache = await caches.open(CACHE);
        await cache.put('/', copy);
        return response;
      } catch {
        return (await caches.match('/')) || (await caches.match(request)) || Response.error();
      }
    })());
    return;
  }
  event.respondWith(caches.match(request).then((cached) => cached || fetch(request).then((response) => {
    if (response.ok) {
      const copy = response.clone();
      void caches.open(CACHE).then((cache) => cache.put(request, copy));
    }
    return response;
  })));
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});
