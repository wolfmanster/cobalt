import type { ParsedPostUrl } from './types.js';

const ALLOWED_HOSTS = new Set(['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com', 'mobile.twitter.com']);

export function parseXPostUrl(input: string): ParsedPostUrl {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new Error('链接格式无效');
  }

  if (url.protocol !== 'https:' || !ALLOWED_HOSTS.has(url.hostname.toLowerCase())) {
    throw new Error('仅支持公开的 X 帖子链接');
  }

  const parts = url.pathname.split('/').filter(Boolean);
  const statusIndex = parts.findIndex((part) => part.toLowerCase() === 'status');
  const tweetId = statusIndex >= 1 ? parts[statusIndex + 1] : undefined;

  if (!tweetId || !/^\d{10,25}$/.test(tweetId)) {
    throw new Error('链接不是单条 X 帖子');
  }

  const username = parts[statusIndex - 1] ?? 'i';
  return {
    tweetId,
    canonicalUrl: `https://x.com/${encodeURIComponent(username)}/status/${tweetId}`,
  };
}

export function extractUrls(text: string): string[] {
  const matches = text.match(/https:\/\/[^\s,;"'<>]+/gi) ?? [];
  return matches.map((url) => url.replace(/[)\].，。！？]+$/u, ''));
}
