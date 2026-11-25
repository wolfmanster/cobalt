import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import express, { type Express } from 'express';
import { z } from 'zod';
import { ArchiveError, normalizeCategoryName, type CategoryStore } from './categories.js';
import { mediaContentType } from './media-stream.js';
import type { JobStore } from './store.js';
import type { DownloadJob, MediaItem } from './types.js';

const chunkSize = 2 * 1024 * 1024;
const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const size = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const date = z.iso.datetime({ offset: true });
const mediaType = /^(?:image\/(?:jpeg|png|webp|gif|avif)|video\/(?:mp4|webm|quicktime))$/i;
const importPost = z.object({
  tweetId: z.string().regex(/^\d{1,30}$/),
  createdAt: date,
  completedAt: date,
  metadata: z.object({
    authorName: z.string().max(512), username: z.string().max(512), userId: z.string().max(128),
    avatarUrl: z.string().max(2048), text: z.string().max(30_000),
    language: z.string().max(32), publishedAt: z.string().max(64),
  }).optional(),
  categories: z.array(z.string().max(120)).max(500),
  media: z.array(z.object({
    sha256: hash, size, filename: z.string().min(1).max(255).regex(/^[^/\\\x00-\x1f\x7f]+$/),
    contentType: z.string().regex(mediaType),
    kind: z.enum(['image', 'video', 'gif']),
  })).max(500),
  unavailableMedia: z.number().int().min(0).max(500).default(0),
  importRevision: hash.optional(),
});
type Fingerprint = { sha256: string; size: number; chunkHashes: string[]; file: string };
type ManifestMedia = Omit<MediaItem, 'sourceUrl' | 'localPath'> & {
  sha256: string; size: number; chunkHashes: string[]; previewUrl: string; downloadUrl: string;
};

export function registerArchiveSync(app: Express, store: JobStore, categories: CategoryStore, notify: () => void) {
  const objects = path.join(store.mediaDir, '.objects');
  const parts = path.join(store.dataDir, 'archive-import');
  const fingerprints = new Map<string, { key: string; value: Promise<Fingerprint> }>();
  const byHash = new Map<string, Fingerprint>();
  const uploads = new Map<string, Promise<unknown>>();
  const archiveRoot = path.resolve(store.mediaDir) + path.sep;
  let commitChain = Promise.resolve<unknown>(undefined);

  async function inspect(file: string) {
    const stat = await fs.stat(file).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
      return undefined;
    });
    if (!stat?.isFile() || !stat.size) return undefined;
    const key = [stat.size, stat.mtimeMs, stat.ctimeMs].join(':');
    const cached = fingerprints.get(file);
    if (cached?.key === key) return cached.value;
    const value = (async (): Promise<Fingerprint> => {
      const handle = await fs.open(file, 'r');
      const full = createHash('sha256');
      const chunkHashes = [];
      try {
        for (let offset = 0; offset < stat.size; offset += chunkSize) {
          const length = Math.min(chunkSize, stat.size - offset);
          const buffer = Buffer.alloc(length);
          let read = 0;
          while (read < length) {
            const { bytesRead } = await handle.read(buffer, read, length - read, offset + read);
            if (!bytesRead) throw new Error('归档文件读取不完整');
            read += bytesRead;
          }
          full.update(buffer);
          chunkHashes.push(sha256(buffer));
        }
      } finally { await handle.close(); }
      const result = { sha256: full.digest('hex'), size: stat.size, chunkHashes, file };
      if (!byHash.has(result.sha256) || file.startsWith(objects + path.sep)) byHash.set(result.sha256, result);
      return result;
    })();
    fingerprints.set(file, { key, value });
    value.catch(() => { if (fingerprints.get(file)?.value === value) fingerprints.delete(file); });
    return value;
  }

  function existingMedia(media: MediaItem) {
    const file = media.localPath && path.resolve(store.dataDir, media.localPath);
    return file && file.startsWith(archiveRoot) ? inspect(file) : Promise.resolve(undefined);
  }

  async function known(hash: string): Promise<Fingerprint | undefined> {
    const object = await inspect(path.join(objects, hash));
    if (object?.sha256 === hash) return object;
    const cached = byHash.get(hash);
    const current = cached && await inspect(cached.file);
    return current?.sha256 === hash ? current : undefined;
  }

  const route = (handler: express.RequestHandler): express.RequestHandler => (req, res, next) =>
    Promise.resolve(handler(req, res, next)).catch((error) => {
      if (error instanceof ArchiveError) return res.status(error.status).json({ error: error.message });
      next(error);
    });

  async function manifest() {
    const snapshot = categories.getSnapshot();
    const summary = snapshot.categories.map(({ normalizedName: _name, ...category }) => category);
    const assignments = new Map<string, string[]>();
    for (const { tweetId, categoryId } of snapshot.assignments) {
      const list = assignments.get(tweetId) ?? [];
      list.push(categoryId);
      assignments.set(tweetId, list);
    }
    const grouped = new Map<string, DownloadJob[]>();
    for (const job of store.list()) {
      if (job.status !== 'completed') continue;
      const members = grouped.get(job.tweetId) ?? [];
      members.push(structuredClone(job));
      grouped.set(job.tweetId, members);
    }
    const posts = [];
    for (const [tweetId, jobs] of grouped) {
      const media = new Map<string, ManifestMedia>();
      let missing = 0;
      for (const job of jobs) {
        for (const { localPath, sourceUrl: _source, ...item } of job.media) {
          const identity = await existingMedia({ ...item, localPath, sourceUrl: '' });
          if (!identity) { missing++; continue; }
          if (media.has(identity.sha256)) continue;
          const previewUrl = '/api/jobs/' + encodeURIComponent(job.id) + '/media/' + encodeURIComponent(item.id);
          media.set(identity.sha256, {
            ...item, size: identity.size, sha256: identity.sha256, chunkHashes: identity.chunkHashes,
            contentType: mediaContentType(item.contentType, item.filename),
            previewUrl, downloadUrl: previewUrl + '?download=1',
          });
        }
      }
      const { importedRevision: _revision, unavailableMedia, ...job } = jobs[0]!;
      const post = {
        ...job, media: [...media.values()], archived: true,
        unavailableMedia: Math.max(unavailableMedia ?? 0, missing),
        categoryIds: (assignments.get(tweetId) ?? []).sort(),
      };
      posts.push({ ...post, version: sha256(JSON.stringify(post)) });
    }
    posts.sort((a, b) => a.tweetId.localeCompare(b.tweetId));
    const version = sha256(JSON.stringify([summary, posts.map((post) => post.version)]));
    return { posts, categories: summary, version, chunkSize };
  }

  app.get('/api/sync', route(async (req, res) => {
    const offset = Math.max(0, Number(req.query.offset) || 0);
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));
    const snapshot = await manifest();
    if (req.query.version && req.query.version !== snapshot.version) {
      return res.status(409).json({ error: '归档已更新，请从第一页重新同步' });
    }
    if (req.query.known === snapshot.version) return res.json({ unchanged: true, version: snapshot.version });
    const posts = snapshot.posts.slice(offset, offset + limit);
    res.json({
      posts, version: snapshot.version, chunkSize, categories: offset === 0 ? snapshot.categories : undefined,
      nextOffset: offset + posts.length < snapshot.posts.length ? offset + posts.length : null,
    });
  }));

  function serializedUpload<T>(hash: string, operation: () => Promise<T>) {
    const task = (uploads.get(hash) ?? Promise.resolve()).catch(() => undefined).then(operation);
    uploads.set(hash, task);
    const release = () => { if (uploads.get(hash) === task) uploads.delete(hash); };
    task.then(release, release);
    return task;
  }

  function validateUpload(params: unknown, rawSize: unknown) {
    const result = z.object({ hash }).safeParse(params);
    const length = size.safeParse(Number(rawSize));
    if (!result.success || !length.success) throw new ArchiveError('媒体哈希或大小无效');
    return { digest: result.data.hash, length: length.data };
  }

  async function uploadStatus(digest: string, length: number) {
    const stored = await known(digest);
    if (stored?.size === length) return { offset: length, complete: true };
    const file = path.join(parts, digest + '.part');
    let offset = (await fs.stat(file).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
      return undefined;
    }))?.size ?? 0;
    // A terminated process can leave an incomplete final write. Resume from the preceding boundary.
    const boundary = offset === length ? offset : offset - offset % chunkSize;
    if (offset !== boundary || offset > length) {
      offset = offset > length ? 0 : boundary;
      await fs.truncate(file, offset);
    }
    if (offset === length) {
      const verified = await inspect(file);
      if (verified?.sha256 !== digest) {
        await fs.rm(file, { force: true });
        throw new ArchiveError('原文件哈希不匹配，请重新传输', 422);
      }
      await fs.mkdir(objects, { recursive: true });
      await fs.rename(file, path.join(objects, digest));
      fingerprints.delete(file);
      return { offset, complete: true };
    }
    return { offset, complete: false };
  }

  app.get('/api/import/media/:hash', route(async (req, res) => {
    const { digest, length } = validateUpload(req.params, req.query.size);
    res.json(await serializedUpload(digest, () => uploadStatus(digest, length)));
  }));
  app.put('/api/import/media/:hash', express.raw({ type: 'application/octet-stream', limit: chunkSize }), route(async (req, res) => {
    const { digest, length } = validateUpload(req.params, req.query.size);
    const offset = Number(req.query.offset);
    if (!Buffer.isBuffer(req.body) || !Number.isSafeInteger(offset) || offset < 0 || offset % chunkSize ||
        offset >= length || req.body.length !== Math.min(chunkSize, length - offset)) {
      throw new ArchiveError('媒体分段范围无效');
    }
    const result = await serializedUpload(digest, async () => {
      const status = await uploadStatus(digest, length);
      if (status.offset !== offset || status.complete) return status;
      await fs.mkdir(parts, { recursive: true });
      await fs.appendFile(path.join(parts, digest + '.part'), req.body);
      return uploadStatus(digest, length);
    });
    res.json(result);
  }));

  app.post('/api/import/categories', route(async (req, res) => {
    const parsed = z.object({ categories: z.array(z.string().max(120)).max(500) }).safeParse(req.body);
    if (!parsed.success) throw new ArchiveError('待导入的分类无效');
    await categories.mergeImported(undefined, parsed.data.categories);
    notify();
    res.json({ ok: true });
  }));

  app.post('/api/import/posts', route(async (req, res) => {
    const parsed = importPost.safeParse(req.body);
    if (!parsed.success) throw new ArchiveError('待导入的帖子或媒体信息无效');
    const input = parsed.data;
    input.categories.forEach(normalizeCategoryName);
    if (input.metadata) {
      const avatar = input.metadata.avatarUrl;
      if (avatar && !/^https:\/\/pbs\.twimg\.com\//i.test(avatar)) input.metadata.avatarUrl = '';
    }
    const commit = commitChain.catch(() => undefined).then(async () => {
      const current = store.findByTweetId(input.tweetId);
      if (current && ['queued', 'resolving', 'downloading'].includes(current.status)) {
        throw new ArchiveError('同一帖子正在服务器下载，稍后会继续合并', 409);
      }
      const existing = store.list().filter((job) => job.tweetId === input.tweetId && job.status === 'completed');
      const job = existing[0];
      if (job && input.importRevision && job.importedRevision === input.importRevision) return { id: job.id };
      const knownHashes = new Set<string>();
      for (const existingJob of existing) {
        for (const media of existingJob.media) {
          const fingerprint = await existingMedia(media);
          if (fingerprint) knownHashes.add(fingerprint.sha256);
        }
      }
      const media = [...(job?.media ?? [])];
      for (const item of input.media) {
        if (knownHashes.has(item.sha256)) continue;
        const fingerprint = await known(item.sha256);
        if (!fingerprint || fingerprint.size !== item.size) throw new ArchiveError('请先传输原文件', 409);
        knownHashes.add(item.sha256);
        const { sha256: _sha, ...fields } = item;
        media.push({ ...fields, id: randomUUID(), downloadedBytes: item.size, totalBytes: item.size,
          sourceUrl: '', localPath: path.relative(store.dataDir, fingerprint.file) });
      }
      await categories.mergeImported(input.tweetId, input.categories);
      const latest = store.findByTweetId(input.tweetId);
      if (latest && ['queued', 'resolving', 'downloading'].includes(latest.status)) {
        throw new ArchiveError('同一帖子正在服务器下载，稍后会继续合并', 409);
      }
      if (latest?.status === 'completed' && latest.id !== job?.id) {
        throw new ArchiveError('服务器归档刚刚更新，稍后会继续合并', 409);
      }
      const canonicalUrl = 'https://x.com/i/status/' + input.tweetId;
      const now = new Date().toISOString();
      const createdAt = job && Date.parse(job.createdAt) < Date.parse(input.createdAt) ? job.createdAt : input.createdAt;
      const completedAt = job?.completedAt && Date.parse(job.completedAt) < Date.parse(input.completedAt) ? job.completedAt : input.completedAt;
      const merged: DownloadJob = {
        id: job?.id ?? randomUUID(), tweetId: input.tweetId, sourceUrl: job?.sourceUrl ?? canonicalUrl,
        canonicalUrl: job?.canonicalUrl ?? canonicalUrl, status: 'completed', progress: 100,
        attempts: job?.attempts ?? 0, metadata: job?.metadata ?? input.metadata, media, createdAt,
        completedAt, updatedAt: now, importedRevision: input.importRevision,
        unavailableMedia: input.unavailableMedia,
      };
      store.set(merged);
      await store.flush();
      notify();
      return { id: merged.id };
    });
    commitChain = commit;
    res.json(await commit);
  }));
}
