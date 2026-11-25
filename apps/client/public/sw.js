const CACHE = 'cobalt-shell-' + (new URL(self.location.href).searchParams.get('v') || '1');
const OFFLINE_MEDIA = /^\/__offline-media\/([a-f0-9]{64})$/;
let database;

function stored(store, key) {
  if (!database) {
    database = new Promise((resolve, reject) => {
      const request = indexedDB.open('cobalt-offline-archive', 1);
      request.onupgradeneeded = () => {
        for (const name of ['state', 'files', 'chunks']) request.result.createObjectStore(name);
      };
      request.onsuccess = () => {
        request.result.onversionchange = () => { request.result.close(); database = undefined; };
        resolve(request.result);
      };
      request.onerror = () => { database = undefined; reject(request.error); };
    });
  }
  return database.then((db) => new Promise((resolve, reject) => {
    const request = db.transaction(store).objectStore(store).get(key);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  }));
}

function byteRange(value, size) {
  if (!value) return [0, size - 1];
  const match = /^bytes=(\d*)-(\d*)$/i.exec(value);
  if (!match || (!match[1] && !match[2])) return null;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return null;
    return [Math.max(0, size - suffix), size - 1];
  }
  const start = Number(match[1]);
  const end = match[2] ? Number(match[2]) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || end < start) return null;
  return [start, Math.min(end, size - 1)];
}

async function offlineMedia(request, url, hash) {
  const file = await stored('files', hash);
  if (!file || file.offset !== file.size) return new Response(null, { status: 404 });
  const header = request.headers.get('range');
  const range = byteRange(header, file.size);
  if (!range) return new Response(null, { status: 416, headers: { 'Content-Range': 'bytes */' + file.size } });
  const [start, end] = range;
  let next = start;
  const headers = {
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
    'Content-Type': file.contentType,
    'Content-Length': String(end - start + 1),
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': 'sandbox',
  };
  if (header) headers['Content-Range'] = 'bytes ' + start + '-' + end + '/' + file.size;
  if (url.searchParams.get('download') === '1') {
    headers['Content-Disposition'] = "attachment; filename*=UTF-8''" + encodeURIComponent(file.filename).replace(/['()*]/g, (char) => '%' + char.charCodeAt(0).toString(16));
  }
  const body = request.method === 'HEAD' ? null : new ReadableStream({
    async pull(controller) {
      const index = Math.floor(next / file.chunkSize);
      const chunkStart = index * file.chunkSize;
      const chunk = await stored('chunks', hash + '/' + index);
      if (!chunk) { controller.error(new Error('本机媒体分段缺失')); return; }
      const skip = next - chunkStart;
      const count = Math.min((chunk.size ?? chunk.byteLength) - skip, end - next + 1);
      if (count <= 0) { controller.error(new Error('本机媒体分段不完整')); return; }
      const bytes = chunk instanceof Blob ? await chunk.slice(skip, skip + count).arrayBuffer() : chunk.slice(skip, skip + count);
      controller.enqueue(new Uint8Array(bytes));
      next += count;
      if (next > end) controller.close();
    },
  });
  return new Response(body, { status: header ? 206 : 200, headers });
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    const shell = await fetch('/', { cache: 'reload' });
    if (!shell.ok) throw new Error('应用外壳下载失败');
    const html = await shell.clone().text();
    const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+\.(?:js|css))"/g)].map((match) => match[1]);
    if (!assets.some((asset) => asset.endsWith('.js'))) throw new Error('应用脚本未找到');
    await cache.addAll([...new Set(assets), '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png']);
    await cache.put('/', shell);
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(Promise.all([
    caches.keys().then((keys) => Promise.all(keys.filter((key) => (key.startsWith('veo-shell-') || key.startsWith('cobalt-shell-')) && key !== CACHE).map((key) => caches.delete(key)))),
    self.clients.claim(),
  ]));
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || !['GET', 'HEAD'].includes(request.method)) return;
  const media = OFFLINE_MEDIA.exec(url.pathname);
  if (media) {
    event.respondWith(offlineMedia(request, url, media[1]).catch(() => new Response(null, { status: 404 })));
    return;
  }
  if (url.pathname === '/api' || url.pathname.startsWith('/api/') || request.method !== 'GET') return;
  if (request.mode === 'navigate') {
    event.respondWith(fetch(request, { signal: AbortSignal.timeout(4000) }).then((response) => {
      if (!response.ok) throw new Error('应用外壳暂不可用');
      return response;
    })
      .catch(() => caches.open(CACHE).then((cache) => cache.match('/')).then((shell) => shell || Response.error())));
    return;
  }
  if (/^\/(?:assets\/|icons\/|manifest\.webmanifest$)/.test(url.pathname)) {
    event.respondWith(caches.open(CACHE).then((cache) => cache.match(request)).then((asset) => asset || fetch(request)));
  }
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});
