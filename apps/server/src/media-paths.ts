import path from 'node:path';
import type { MediaItem, PostMetadata } from './types.js';

const POST_TIME_ZONE = 'Asia/Shanghai';

function sanitizePathSegment(value: string, fallback: string, maxLength = 180): string {
  let segment = value
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, '')
    .replace(/[<>:"/\\|?*]/g, '_')
    .trim()
    .replace(/[. ]+$/g, '');

  if (!segment) segment = fallback;
  if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(segment)) segment = `_${segment}`;

  // Keep each Windows path component below the usual 255-character limit.
  segment = Array.from(segment).slice(0, maxLength).join('').replace(/[. ]+$/g, '');
  return segment || fallback;
}

export function formatPublishedDate(isoDate: string | undefined): string {
  if (!isoDate) return 'unknown-date';
  const date = new Date(isoDate);
  if (Number.isNaN(date.getTime())) return 'unknown-date';

  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: POST_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function buildAuthorFolder(metadata: Pick<PostMetadata, 'authorName' | 'userId'>, fallback: string): string {
  return sanitizePathSegment(`${metadata.authorName}_${metadata.userId}`, fallback);
}

export function buildPostFolder(metadata: Pick<PostMetadata, 'publishedAt' | 'text'> | undefined, tweetId: string): string {
  const date = formatPublishedDate(metadata?.publishedAt);
  // Reserve room for the date and tweet ID so the ID is always retained.
  const text = sanitizePathSegment(metadata?.text?.trim() || tweetId, tweetId, 140);
  return sanitizePathSegment(`${date}_${text}_${tweetId}`, `${date}_${tweetId}_${tweetId}`);
}

export function buildMediaFilename(media: MediaItem, index: number): string {
  const extension = path.extname(media.filename).slice(1).toLowerCase() || (media.kind === 'video' ? 'mp4' : 'jpg');
  const suffix = media.kind === 'video' ? 'vdo' : 'pic';
  return `${index + 1}-${suffix}.${extension}`;
}
