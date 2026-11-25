import { createServer } from 'node:http';

const MEDIA_BYTES = Buffer.from('0123456789abcdef');

function publicMedia(job, media) {
  return {
    id: media.id,
    kind: media.kind,
    filename: media.filename,
    contentType: media.contentType,
    size: MEDIA_BYTES.length,
    downloadedBytes: MEDIA_BYTES.length,
    previewUrl: `/api/jobs/${job.id}/media/${media.id}`,
    downloadUrl: `/api/jobs/${job.id}/media/${media.id}?download=1`,
  };
}

function publicJob(job) {
  return {
    id: job.id,
    tweetId: job.tweetId,
    sourceUrl: job.sourceUrl,
    canonicalUrl: job.canonicalUrl,
    status: job.status,
    progress: job.progress,
    metadata: job.metadata,
    media: job.status === 'completed' ? job.media.map((media) => publicMedia(job, media)) : [],
    attempts: job.attempts,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    completedAt: job.completedAt,
    error: job.error,
  };
}

function authorKey(job) {
  const userId = job.metadata?.userId?.trim();
  if (userId) return `id:${userId}`;
  const username = job.metadata?.username?.trim();
  if (username) return `name:${username.toLowerCase()}`;
  return 'unknown';
}

function latestCompleted(jobs) {
  const byTweet = new Map();
  for (const job of jobs) {
    if (job.status !== 'completed') continue;
    const current = byTweet.get(job.tweetId);
    const stamp = job.completedAt || job.createdAt;
    const currentStamp = current ? (current.completedAt || current.createdAt) : '';
    if (!current || stamp > currentStamp || (stamp === currentStamp && job.id > current.id)) byTweet.set(job.tweetId, job);
  }
  return [...byTweet.values()].sort((left, right) => (right.completedAt || right.createdAt).localeCompare(left.completedAt || left.createdAt) || right.id.localeCompare(left.id));
}

function normalizeQuery(value) {
  const text = String(value ?? '').trim().replace(/^@/, '').trim().toLowerCase();
  return text;
}

function seedJobs() {
  const jobs = [];
  jobs.push({
    id: 'gallery',
    tweetId: '900',
    sourceUrl: 'https://x.com/mountain/status/900',
    canonicalUrl: 'https://x.com/i/status/900',
    status: 'completed',
    progress: 100,
    metadata: { authorName: '山间来信', username: 'Mountain', userId: '42', avatarUrl: '', text: '湖面的风', language: 'zh', publishedAt: '2026-09-29T00:00:00.000Z' },
    media: [1, 2, 3].map((index) => ({ id: `pic-${index}`, kind: index === 3 ? 'gif' : 'image', filename: index === 3 ? '3-pic.gif' : `${index}-pic.jpg`, contentType: index === 3 ? 'video/mp4' : 'image/jpeg' })),
    attempts: 1,
    createdAt: '2026-11-24T08:00:00.000Z',
    updatedAt: '2026-11-24T08:00:00.000Z',
    completedAt: '2026-11-24T08:00:00.000Z',
  });
  for (let index = 0; index < 25; index += 1) {
    jobs.push({
      id: `post-${index}`,
      tweetId: String(1000 + index),
      sourceUrl: `https://x.com/mountain/status/${1000 + index}`,
      canonicalUrl: `https://x.com/i/status/${1000 + index}`,
      status: 'completed',
      progress: 100,
      metadata: { authorName: '山间来信', username: 'Mountain', userId: '42', avatarUrl: '', text: `风景记录 ${index}`, language: 'zh', publishedAt: '2026-09-01T00:00:00.000Z' },
      media: [{ id: 'only', kind: 'image', filename: '1-pic.jpg', contentType: 'image/jpeg' }],
      attempts: 1,
      createdAt: `2026-11-23T00:${String(index).padStart(2, '0')}:00.000Z`,
      updatedAt: `2026-11-23T00:${String(index).padStart(2, '0')}:00.000Z`,
      completedAt: `2026-11-23T01:${String(index).padStart(2, '0')}:00.000Z`,
    });
  }
  jobs.push({
    id: 'active-job', tweetId: '42', sourceUrl: 'https://x.com/mountain/status/42', canonicalUrl: 'https://x.com/i/status/42',
    status: 'downloading', progress: 10, media: [], attempts: 1,
    createdAt: '2026-11-24T09:00:00.000Z', updatedAt: '2026-11-24T09:00:00.000Z',
    metadata: { authorName: '山间来信', username: 'Mountain', userId: '42', avatarUrl: '', text: '正在下载', language: 'zh', publishedAt: '2026-11-24T00:00:00.000Z' },
  });
  jobs.push({
    id: 'failed-job', tweetId: '43', sourceUrl: 'https://x.com/mountain/status/43', canonicalUrl: 'https://x.com/i/status/43',
    status: 'failed', progress: 0, media: [], attempts: 1, error: '网络中断',
    createdAt: '2026-11-24T07:00:00.000Z', updatedAt: '2026-11-24T07:00:00.000Z',
  });
  return jobs;
}

export function startPwaFixture() {
  const jobs = seedJobs();
  const categories = [];
  const assignments = [];
  let cobalt = true;
  let posts = 0;
  const sse = new Set();
  const requests = [];

  const notify = () => { for (const response of sse) response.write('data: {"updated":true}\n\n'); };
  const timer = setInterval(() => {
    const active = jobs.find((job) => job.id === 'active-job' && job.status === 'downloading');
    if (!active) return;
    active.progress = (active.progress + 10) % 100;
    active.updatedAt = new Date().toISOString();
    notify();
  }, 250);

  function page(url) {
    const offset = Math.max(0, Number(url.searchParams.get('offset') ?? url.searchParams.get('historyOffset') ?? 0) || 0);
    const limitRaw = Number(url.searchParams.get('limit') ?? url.searchParams.get('historyLimit') ?? 25);
    const limit = !Number.isFinite(limitRaw) || limitRaw <= 0 ? 25 : Math.min(50, limitRaw);
    return { offset, limit };
  }

  function completedPosts(url) {
    const query = normalizeQuery(url.searchParams.get('query'));
    const author = url.searchParams.get('authorKey') || '';
    const categoryId = url.searchParams.get('categoryId') || '';
    return latestCompleted(jobs).filter((job) => {
      if (author && authorKey(job) !== author) return false;
      const assigned = assignments.filter((item) => item.tweetId === job.tweetId).map((item) => item.categoryId);
      if (categoryId === '__uncategorized__' && assigned.length) return false;
      if (categoryId && categoryId !== '__uncategorized__' && !assigned.includes(categoryId)) return false;
      if (!query) return true;
      const haystack = [job.metadata?.text, job.metadata?.authorName, job.metadata?.username, job.tweetId].join('\n').toLowerCase();
      return haystack.includes(query);
    });
  }

  function send(response, status, body, headers = {}) {
    const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
    response.writeHead(status, { 'cache-control': 'no-store', 'content-type': 'application/json; charset=utf-8', ...headers });
    response.end(payload);
  }

  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    requests.push({ method: request.method, path: url.pathname + url.search });
    if (request.method === 'GET' && url.pathname === '/api/account') {
      const device = { id: 'fixture', name: 'Browser', expiresAt: Date.now() + 60_000 };
      return send(response, 200, { device, devices: [device] });
    }
    if (request.method === 'GET' && url.pathname === '/api/x-session') {
      return send(response, 200, { available: false, configured: false });
    }
    if (request.method === 'GET' && url.pathname === '/api/health') {
      send(response, cobalt ? 200 : 503, { ok: true, cobalt, cobaltUrl: 'http://127.0.0.1:9000' });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/events') {
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'connection': 'keep-alive', 'x-accel-buffering': 'no' });
      response.write('data: {"updated":true}\n\n');
      sse.add(response);
      request.on('close', () => sse.delete(response));
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/jobs') {
      const { offset, limit } = page(url);
      const terminal = new Set(['completed', 'failed', 'canceled']);
      const active = jobs.filter((job) => !terminal.has(job.status));
      const history = jobs.filter((job) => terminal.has(job.status)).sort((left, right) => right.createdAt.localeCompare(left.createdAt));
      send(response, 200, { jobs: [...active, ...history.slice(offset, offset + limit)].map(publicJob), historyTotal: history.length, completedToday: history.filter((job) => job.status === 'completed').length });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/posts') {
      const { offset, limit } = page(url);
      const matched = completedPosts(url);
      send(response, 200, { jobs: matched.slice(offset, offset + limit).map(publicJob), total: matched.length });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/authors') {
      const query = normalizeQuery(url.searchParams.get('query'));
      const { offset, limit } = page(url);
      const groups = new Map();
      for (const job of latestCompleted(jobs)) {
        const key = authorKey(job);
        const group = groups.get(key) ?? [];
        group.push(job);
        groups.set(key, group);
      }
      const authors = [...groups.entries()].filter(([, group]) => !query || group.some((job) => `${job.metadata?.authorName ?? ''} ${job.metadata?.username ?? ''}`.toLowerCase().includes(query))).map(([key, group]) => {
        const latest = group[0];
        return { authorKey: key, authorName: latest.metadata?.authorName || '作者未知', username: latest.metadata?.username || '', avatarUrl: '', tweetCount: group.length, latestDownloadedAt: latest.completedAt };
      });
      send(response, 200, { authors: authors.slice(offset, offset + limit), total: authors.length });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/tweet-categories') {
      const completedIds = new Set(latestCompleted(jobs).map((job) => job.tweetId));
      const assigned = new Set(assignments.filter((item) => completedIds.has(item.tweetId)).map((item) => item.tweetId));
      send(response, 200, {
        categories: categories.map((category) => ({ ...category, tweetCount: new Set(assignments.filter((item) => item.categoryId === category.id && completedIds.has(item.tweetId)).map((item) => item.tweetId)).size })),
        allTotal: completedIds.size,
        uncategorizedTotal: [...completedIds].filter((tweetId) => !assigned.has(tweetId)).length,
      });
      return;
    }
    if (url.pathname === '/api/tweet-categories' && request.method === 'POST') {
      const body = JSON.parse(await readBody(request));
      const name = String(body.name ?? '').trim();
      if ([...name].length < 1 || [...name].length > 30) return send(response, 400, { error: '分类名需为 1–30 个字符' });
      if (categories.some((category) => category.name.toLowerCase() === name.toLowerCase())) return send(response, 400, { error: '分类名已存在' });
      const category = { id: `cat-${categories.length + 1}`, name, createdAt: new Date().toISOString(), tweetCount: 0 };
      categories.push(category);
      notify();
      send(response, 201, category);
      return;
    }
    if (url.pathname === '/api/tweet-categories/assignments/query' && request.method === 'POST') {
      const body = JSON.parse(await readBody(request));
      const result = {};
      for (const tweetId of body.tweetIds ?? []) result[tweetId] = assignments.filter((item) => item.tweetId === tweetId).map((item) => item.categoryId);
      send(response, 200, { assignments: result });
      return;
    }
    if (url.pathname === '/api/tweet-categories/assignments' && request.method === 'POST') {
      const body = JSON.parse(await readBody(request));
      const tweetIds = [...new Set((body.tweetIds ?? []).map((item) => String(item).trim()).filter(Boolean))];
      if (!tweetIds.length) return send(response, 400, { error: '请选择至少一条推文' });
      for (const tweetId of tweetIds) {
        for (const categoryId of body.addCategoryIds ?? []) if (!assignments.some((item) => item.tweetId === tweetId && item.categoryId === categoryId)) assignments.push({ tweetId, categoryId });
        for (const categoryId of body.removeCategoryIds ?? []) {
          const index = assignments.findIndex((item) => item.tweetId === tweetId && item.categoryId === categoryId);
          if (index >= 0) assignments.splice(index, 1);
        }
      }
      notify();
      send(response, 200, { updated: tweetIds.length });
      return;
    }
    const categoryMatch = url.pathname.match(/^\/api\/tweet-categories\/([^/]+)$/);
    if (categoryMatch && request.method === 'PATCH') {
      const category = categories.find((item) => item.id === decodeURIComponent(categoryMatch[1]));
      if (!category) return send(response, 404, { error: '分类不存在' });
      const body = JSON.parse(await readBody(request));
      category.name = String(body.name ?? '').trim();
      notify();
      send(response, 200, { ...category, tweetCount: 0 });
      return;
    }
    if (categoryMatch && request.method === 'DELETE') {
      const id = decodeURIComponent(categoryMatch[1]);
      const index = categories.findIndex((item) => item.id === id);
      if (index < 0) return send(response, 404, { error: '分类不存在' });
      categories.splice(index, 1);
      for (let cursor = assignments.length - 1; cursor >= 0; cursor -= 1) if (assignments[cursor].categoryId === id) assignments.splice(cursor, 1);
      notify();
      send(response, 200, { deleted: true });
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/jobs') {
      posts += 1;
      const body = JSON.parse(await readBody(request));
      const created = [];
      const duplicates = [];
      const rejected = [];
      const seen = new Set();
      for (const sourceUrl of body.urls ?? []) {
        const match = String(sourceUrl).match(/status\/(\d+)/);
        if (!match) { rejected.push({ url: sourceUrl, error: '链接无效' }); continue; }
        if (seen.has(match[1])) continue;
        seen.add(match[1]);
        const existing = jobs.find((job) => job.tweetId === match[1] && !['failed', 'canceled'].includes(job.status));
        if (existing) { duplicates.push(publicJob(existing)); continue; }
        const job = { id: `new-${match[1]}`, tweetId: match[1], sourceUrl, canonicalUrl: `https://x.com/i/status/${match[1]}`, status: 'downloading', progress: 5, media: [], attempts: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
        jobs.push(job);
        created.push(publicJob(job));
      }
      notify();
      send(response, created.length ? 202 : 200, { created, duplicates, rejected });
      return;
    }
    const action = url.pathname.match(/^\/api\/jobs\/([^/]+)\/(cancel|retry)$/);
    if (action && request.method === 'POST') {
      const job = jobs.find((item) => item.id === decodeURIComponent(action[1]));
      if (!job) return send(response, 404, { error: '任务不存在' });
      if (action[2] === 'cancel') { job.status = 'canceled'; job.progress = 0; }
      if (action[2] === 'retry') { job.status = 'downloading'; job.progress = 5; job.error = undefined; }
      notify();
      send(response, 200, publicJob(job));
      return;
    }
    if (request.method === 'DELETE' && url.pathname === '/api/history/failed') {
      const count = jobs.length;
      for (let index = jobs.length - 1; index >= 0; index -= 1) if (jobs[index].status === 'failed') jobs.splice(index, 1);
      notify();
      return send(response, 200, { removed: count - jobs.length });
    }
    const media = url.pathname.match(/^\/api\/jobs\/([^/]+)\/media\/([^/]+)$/);
    if (media && request.method === 'GET') {
      const job = jobs.find((item) => item.id === decodeURIComponent(media[1]));
      const item = job?.media.find((entry) => entry.id === decodeURIComponent(media[2]));
      if (!job || !item || job.status !== 'completed') return send(response, 404, { error: '媒体尚不可用' });
      const range = request.headers.range;
      const headers = { 'content-type': item.contentType || 'application/octet-stream', 'accept-ranges': 'bytes', 'cache-control': 'private' };
      if (url.searchParams.get('download') === '1') headers['content-disposition'] = `attachment; filename="${item.filename}"; filename*=UTF-8''${encodeURIComponent(item.filename)}`;
      if (range === 'bytes=0-3') {
        response.writeHead(206, { ...headers, 'content-range': `bytes 0-3/${MEDIA_BYTES.length}`, 'content-length': '4' });
        response.end(MEDIA_BYTES.subarray(0, 4));
        return;
      }
      response.writeHead(200, { ...headers, 'content-length': String(MEDIA_BYTES.length) });
      response.end(MEDIA_BYTES);
      return;
    }
    send(response, 404, { error: 'not found' });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({
        origin: `http://127.0.0.1:${address.port}`,
        requests,
        setCobalt(value) { cobalt = value; },
        postCount: () => posts,
        reset() {
          const fresh = seedJobs();
          jobs.splice(0, jobs.length, ...fresh);
          categories.splice(0, categories.length);
          assignments.splice(0, assignments.length);
          posts = 0;
          requests.splice(0, requests.length);
          cobalt = true;
          const active = jobs.find((job) => job.id === 'active-job');
          if (active) active.progress = 10;
        },
        close: () => new Promise((done) => { clearInterval(timer); server.close(() => done()); }),
      });
    });
  });
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8') || '{}'));
    request.on('error', reject);
  });
}
