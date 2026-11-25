import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { Request, Response } from 'express';
import type { DownloadJob } from './types.js';

const EXTENSION_TYPES: Record<string, string> = {
  mp4: 'video/mp4',
  gif: 'image/gif',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
};

export interface ByteRange {
  start: number;
  end: number;
}

export function contentDispositionAttachment(filename: string): string {
  const cleaned = filename.replace(/[\r\n"]/g, '');
  const ascii = [...cleaned].map((char) => {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code > 0x7e || char === '\\' || char === ';') return '_';
    return char;
  }).join('') || 'download';
  const encoded = encodeURIComponent(cleaned).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

export function mediaContentType(contentType: string | undefined, filename: string): string {
  const stored = contentType?.split(';')[0]?.trim();
  if (stored) return stored;
  const extension = path.extname(filename).slice(1).toLowerCase();
  return EXTENSION_TYPES[extension] ?? 'application/octet-stream';
}

/** One `bytes=` range. `null` means the header is absent or uses an unsupported unit. */
export function parseByteRange(header: string | undefined, size: number): ByteRange | null | 'unsatisfiable' {
  if (!header) return null;
  const value = header.trim();
  if (!/^bytes=/i.test(value)) return null;
  const match = /^bytes=(\d*)-(\d*)$/i.exec(value);
  if (!match || size < 0) return 'unsatisfiable';
  const startText = match[1] ?? '';
  const endText = match[2] ?? '';
  if (startText === '' && endText === '') return 'unsatisfiable';
  if (size === 0) return 'unsatisfiable';
  if (startText === '') {
    const suffix = Number(endText);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return 'unsatisfiable';
    const length = Math.min(suffix, size);
    return { start: size - length, end: size - 1 };
  }
  const start = Number(startText);
  if (!Number.isSafeInteger(start) || start >= size) return 'unsatisfiable';
  const end = endText === '' ? size - 1 : Number(endText);
  if (!Number.isSafeInteger(end) || end < start) return 'unsatisfiable';
  return { start, end: Math.min(end, size - 1) };
}

export async function streamJobMedia(req: Request, res: Response, input: {
  dataDir: string;
  mediaDir: string;
  job: DownloadJob | undefined;
  mediaId: string;
  download: boolean;
}): Promise<void> {
  const media = input.job?.media.find((item) => item.id === input.mediaId);
  if (!input.job || !media?.localPath || input.job.status !== 'completed') {
    res.status(404).json({ error: '媒体尚不可用' });
    return;
  }
  const filePath = path.resolve(input.dataDir, media.localPath);
  const mediaRoot = path.resolve(input.mediaDir);
  if (!filePath.startsWith(`${mediaRoot}${path.sep}`)) {
    res.status(404).json({ error: '媒体文件不存在' });
    return;
  }
  let stat: Awaited<ReturnType<typeof fsp.stat>>;
  try {
    stat = await fsp.stat(filePath);
  } catch {
    res.status(404).json({ error: '媒体文件不存在' });
    return;
  }
  if (!stat.isFile()) {
    res.status(404).json({ error: '媒体文件不存在' });
    return;
  }

  const size = stat.size;
  const range = parseByteRange(typeof req.headers.range === 'string' ? req.headers.range : undefined, size);
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', mediaContentType(media.contentType, media.filename));
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', 'sandbox');
  if (input.download) res.setHeader('Content-Disposition', contentDispositionAttachment(media.filename));
  if (range === 'unsatisfiable') {
    res.status(416);
    res.setHeader('Content-Range', `bytes */${size}`);
    res.end();
    return;
  }
  if (size === 0) {
    res.status(200);
    res.setHeader('Content-Length', '0');
    res.end();
    return;
  }
  const start = range?.start ?? 0;
  const end = range?.end ?? size - 1;
  res.status(range ? 206 : 200);
  if (range) res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
  res.setHeader('Content-Length', String(end - start + 1));
  const stream = fs.createReadStream(filePath, { start, end });
  stream.on('error', () => {
    if (!res.headersSent) res.status(404).json({ error: '媒体文件不存在' });
    else res.destroy();
  });
  stream.pipe(res);
}
