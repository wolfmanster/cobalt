import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type Express, type NextFunction, type Response } from 'express';
import cors from 'cors';
import { z } from 'zod';
import { listAuthors, listCategorySummaries, listDownloadedPosts, parsePage } from './archive-query.js';
import { ArchiveError, CategoryStore, type StoredCategory } from './categories.js';
import { jobList } from './job-list.js';
import { DownloadQueue } from './queue.js';
import { JobStore } from './store.js';
import { parseXPostUrl } from './x-url.js';
import type { DownloadJob } from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface RunningApp {
  app: Express;
  store: JobStore;
  queue: DownloadQueue;
  categories: CategoryStore;
  dataDir: string;
}

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

function publicCategory(category: StoredCategory, tweetCount: number) {
  return { id: category.id, name: category.name, createdAt: category.createdAt, tweetCount };
}

function sendError(res: Response, error: unknown, next: NextFunction) {
  if (error instanceof ArchiveError) return res.status(error.status).json({ error: error.message });
  return next(error);
}

export async function createApp(options: { dataDir?: string; clientDist?: string } = {}): Promise<RunningApp> {
  const dataDir = path.resolve(options.dataDir ?? process.env.DATA_DIR ?? path.join(__dirname, '../../../data'));
  const categories = new CategoryStore(dataDir);
  await categories.init();
  const store = new JobStore(dataDir, categories);
  await store.init();
  const queue = new DownloadQueue(store);
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '1mb' }));
  app.use('/api', (req, res, next) => {
    if (req.path === '/events' || req.path.includes('/media/')) return next();
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  const notify = () => queue.emit('change');

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

  app.get('/api/jobs', (req, res) => {
    const { offset, limit } = parsePage(req.query.historyOffset, req.query.historyLimit);
    const result = jobList(store.list(), offset, limit);
    res.json({ ...result, jobs: result.jobs.map(publicJob) });
  });

  app.get('/api/posts', (req, res) => {
    const page = parsePage(req.query.offset, req.query.limit);
    const result = listDownloadedPosts(store.list(), categories.getSnapshot(), {
      authorKey: typeof req.query.authorKey === 'string' && req.query.authorKey ? req.query.authorKey : undefined,
      categoryId: typeof req.query.categoryId === 'string' ? req.query.categoryId : undefined,
      query: typeof req.query.query === 'string' ? req.query.query : '',
      ...page,
    });
    res.json({ jobs: result.jobs.map(publicJob), total: result.total });
  });

  app.get('/api/authors', (req, res) => {
    const page = parsePage(req.query.offset, req.query.limit);
    res.json(listAuthors(store.list(), typeof req.query.query === 'string' ? req.query.query : '', page.offset, page.limit));
  });

  app.get('/api/tweet-categories', (_req, res) => {
    res.json(listCategorySummaries(store.list(), categories.getSnapshot()));
  });

  app.post('/api/tweet-categories', async (req, res, next) => {
    const parsed = z.object({ name: z.string() }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: '分类名需为 1–30 个字符' });
    try {
      const category = await categories.create(parsed.data.name);
      notify();
      return res.status(201).json(publicCategory(category, 0));
    } catch (error) {
      return sendError(res, error, next);
    }
  });

  app.post('/api/tweet-categories/assignments/query', (req, res) => {
    const parsed = z.object({ tweetIds: z.array(z.string()) }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: '请选择至少一条推文' });
    return res.json({ assignments: categories.assignmentsFor(parsed.data.tweetIds) });
  });

  app.post('/api/tweet-categories/assignments', async (req, res, next) => {
    const parsed = z.object({
      tweetIds: z.array(z.string()),
      addCategoryIds: z.array(z.string()).optional(),
      removeCategoryIds: z.array(z.string()).optional(),
    }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: '请选择至少一条推文' });
    try {
      const result = await categories.updateAssignments(parsed.data.tweetIds, parsed.data.addCategoryIds, parsed.data.removeCategoryIds);
      notify();
      return res.json(result);
    } catch (error) {
      return sendError(res, error, next);
    }
  });

  app.patch('/api/tweet-categories/:id', async (req, res, next) => {
    const parsed = z.object({ name: z.string() }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: '分类名需为 1–30 个字符' });
    try {
      const category = await categories.rename(String(req.params.id), parsed.data.name);
      const summary = listCategorySummaries(store.list(), categories.getSnapshot()).categories.find((item) => item.id === category.id);
      notify();
      return res.json(summary ?? publicCategory(category, 0));
    } catch (error) {
      return sendError(res, error, next);
    }
  });

  app.delete('/api/tweet-categories/:id', async (req, res, next) => {
    try {
      const result = await categories.delete(String(req.params.id));
      notify();
      return res.json(result);
    } catch (error) {
      return sendError(res, error, next);
    }
  });

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
    const id = String(req.params.id);
    if (!queue.cancel(id)) return res.status(409).json({ error: '该任务无法取消' });
    return res.json(publicJob(store.get(id)!));
  });

  app.post('/api/jobs/:id/retry', (req, res) => {
    const id = String(req.params.id);
    if (!queue.retry(id)) return res.status(409).json({ error: '该任务无法重试' });
    return res.json(publicJob(store.get(id)!));
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
      return res.json({ ok: true });
    } catch (error) {
      return res.status(500).json({ error: error instanceof Error ? error.message : '无法打开媒体文件夹' });
    }
  });

  app.get('/api/jobs/:jobId/media/:mediaId', async (req, res) => {
    const job = store.get(String(req.params.jobId));
    const media = job?.media.find((item) => item.id === String(req.params.mediaId));
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
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    const send = () => res.write('data: {"updated":true}\n\n');
    send();
    const listener = () => send();
    queue.on('change', listener);
    const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 20_000);
    req.on('close', () => {
      clearInterval(heartbeat);
      queue.off('change', listener);
    });
  });

  const clientDist = path.resolve(options.clientDist ?? process.env.CLIENT_DIST ?? path.join(__dirname, '../../client/dist'));
  if (fs.existsSync(clientDist)) {
    app.use(express.static(clientDist, {
      setHeaders(res, filePath) {
        const base = path.basename(filePath);
        if (base === 'sw.js' || base === 'index.html') res.setHeader('Cache-Control', 'no-cache');
      },
    }));
    app.get('*', (_req, res) => {
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(path.join(clientDist, 'index.html'));
    });
  }

  queue.restore();
  return { app, store, queue, categories, dataDir };
}
