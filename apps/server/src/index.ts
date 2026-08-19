import 'dotenv/config';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import express from 'express';
import cors from 'cors';
import { z } from 'zod';
import { JobStore } from './store.js';
import { DownloadQueue } from './queue.js';
import { parseXPostUrl } from './x-url.js';
import type { DownloadJob } from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(process.env.DATA_DIR ?? path.join(__dirname, '../../../data'));
const store = new JobStore(dataDir);
await store.init();
const queue = new DownloadQueue(store);

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

function publicJob(job: DownloadJob) {
  const { avatarPath: _legacyAvatarPath, ...visibleJob } = job as DownloadJob & { avatarPath?: string };
  return {
    ...visibleJob,
    metadata: job.metadata,
    media: job.media.map(({ sourceUrl: _sourceUrl, localPath: _localPath, ...media }) => ({
      ...media,
      previewUrl: `/api/jobs/${job.id}/media/${media.id}`,
      downloadUrl: `/api/jobs/${job.id}/media/${media.id}?download=1`,
    })),
  };
}

app.get('/api/health', async (_req, res) => {
  const cobaltUrl = (process.env.COBALT_URL ?? 'http://127.0.0.1:9000').replace(/\/$/, '');
  let cobalt = false;
  try {
    cobalt = (await fetch(`${cobaltUrl}/`, { signal: AbortSignal.timeout(2500) })).ok;
  } catch {
    // Health response reports an unavailable dependency.
  }
  res.status(cobalt ? 200 : 503).json({ ok: true, cobalt, cobaltUrl });
});

app.get('/api/jobs', (_req, res) => res.json(store.list().map(publicJob)));

app.post('/api/jobs', (req, res) => {
  const result = z.object({ urls: z.array(z.string()).min(1).max(200) }).safeParse(req.body);
  if (!result.success) return res.status(400).json({ error: '请提供 1–200 条帖子链接' });

  const created: DownloadJob[] = [];
  const duplicates: DownloadJob[] = [];
  const rejected: Array<{ url: string; error: string }> = [];
  const seen = new Set<string>();

  for (const sourceUrl of result.data.urls) {
    try {
      const parsed = parseXPostUrl(sourceUrl);
      if (seen.has(parsed.tweetId)) continue;
      seen.add(parsed.tweetId);
      const existing = store.findByTweetId(parsed.tweetId);
      if (existing) {
        duplicates.push(existing);
        continue;
      }
      const now = new Date().toISOString();
      const job: DownloadJob = {
        id: randomUUID(),
        tweetId: parsed.tweetId,
        sourceUrl: sourceUrl.trim(),
        canonicalUrl: parsed.canonicalUrl,
        status: 'queued',
        progress: 0,
        media: [],
        attempts: 0,
        createdAt: now,
        updatedAt: now,
      };
      store.set(job);
      queue.enqueue(job.id);
      created.push(job);
    } catch (error) {
      rejected.push({ url: sourceUrl, error: error instanceof Error ? error.message : '链接无效' });
    }
  }

  return res.status(created.length ? 202 : 200).json({
    created: created.map(publicJob),
    duplicates: duplicates.map(publicJob),
    rejected,
  });
});

app.post('/api/jobs/:id/cancel', (req, res) => {
  if (!queue.cancel(req.params.id)) return res.status(409).json({ error: '该任务无法取消' });
  return res.json(publicJob(store.get(req.params.id)!));
});

app.post('/api/jobs/:id/retry', (req, res) => {
  if (!queue.retry(req.params.id)) return res.status(409).json({ error: '该任务无法重试' });
  return res.json(publicJob(store.get(req.params.id)!));
});

app.delete('/api/history', async (_req, res) => res.json({ removed: await store.clearCompleted() }));

app.post('/api/open-media-folder', async (_req, res) => {
  const platform = process.platform;
  const command = platform === 'win32' ? 'explorer.exe' : platform === 'darwin' ? 'open' : 'xdg-open';

  try {
    await new Promise<void>((resolve, reject) => {
      const opener = spawn(command, [store.mediaDir], { detached: true, stdio: 'ignore' });
      opener.once('error', reject);
      opener.once('spawn', () => {
        opener.unref();
        resolve();
      });
    });
    return res.json({ path: store.mediaDir });
  } catch (error) {
    return res.status(500).json({ error: error instanceof Error ? error.message : '无法打开媒体文件夹' });
  }
});

app.get('/api/jobs/:jobId/media/:mediaId', async (req, res) => {
  const job = store.get(req.params.jobId);
  const media = job?.media.find((item) => item.id === req.params.mediaId);
  if (!job || !media?.localPath || job.status !== 'completed') return res.status(404).json({ error: '媒体尚不可用' });
  const filePath = path.resolve(store.dataDir, media.localPath);
  if (!filePath.startsWith(`${path.resolve(store.mediaDir)}${path.sep}`) || !fs.existsSync(filePath)) {
    return res.status(404).json({ error: '媒体文件不存在' });
  }
  res.setHeader('Content-Type', media.contentType ?? 'application/octet-stream');
  res.setHeader('Cache-Control', 'private, max-age=3600');
  if (req.query.download === '1') res.setHeader('Content-Disposition', `attachment; filename="${media.filename}"`);
  return fs.createReadStream(filePath).pipe(res);
});

app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  const send = (jobs = store.list()) => res.write(`data: ${JSON.stringify(jobs.map(publicJob))}\n\n`);
  send();
  const listener = (jobs: DownloadJob[]) => send(jobs);
  queue.on('change', listener);
  const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 20_000);
  req.on('close', () => {
    clearInterval(heartbeat);
    queue.off('change', listener);
  });
});

const clientDist = path.resolve(process.env.CLIENT_DIST ?? path.join(__dirname, '../../client/dist'));
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get('*', (_req, res) => res.sendFile(path.join(clientDist, 'index.html')));
}

queue.restore();
const port = Number(process.env.PORT ?? 4100);
const host = process.env.HOST ?? '127.0.0.1';
const server = app.listen(port, host, () => {
  console.log(`X Media Archive: http://${host}:${port}`);
  console.log(`Cobalt: ${process.env.COBALT_URL ?? 'http://127.0.0.1:9000'}`);
});

async function shutdown() {
  server.close();
  await store.flush();
  await fsp.mkdir(dataDir, { recursive: true });
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
