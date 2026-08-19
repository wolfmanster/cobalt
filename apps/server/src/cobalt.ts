import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { MediaItem } from './types.js';

interface CobaltPickerItem {
  type: 'photo' | 'video' | 'gif';
  url: string;
  thumb?: string;
}

interface CobaltResponse {
  status: string;
  url?: string;
  filename?: string;
  picker?: CobaltPickerItem[];
  error?: { code?: string };
}

function extensionFromUrl(rawUrl: string, fallback: string): string {
  try {
    const ext = path.extname(new URL(rawUrl).pathname).slice(1).toLowerCase();
    if (/^[a-z0-9]{2,5}$/.test(ext)) return ext;
  } catch {
    // Use the media-type fallback.
  }
  return fallback;
}

function kindFromFilename(filename: string): MediaItem['kind'] {
  const ext = path.extname(filename).toLowerCase();
  if (ext === '.gif') return 'gif';
  if (['.jpg', '.jpeg', '.png', '.webp', '.avif'].includes(ext)) return 'image';
  return 'video';
}

export async function resolveMedia(canonicalUrl: string, tweetId: string, signal?: AbortSignal): Promise<MediaItem[]> {
  const baseUrl = (process.env.COBALT_URL ?? 'http://127.0.0.1:9000').replace(/\/$/, '');
  const headers: Record<string, string> = {
    accept: 'application/json',
    'content-type': 'application/json',
  };
  if (process.env.COBALT_API_KEY) headers.authorization = `Api-Key ${process.env.COBALT_API_KEY}`;

  let response: Response;
  try {
    response = await fetch(`${baseUrl}/`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        url: canonicalUrl,
        alwaysProxy: true,
        convertGif: true,
        downloadMode: 'auto',
        filenameStyle: 'basic',
        localProcessing: 'disabled',
      }),
      signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error;
    throw new Error(`无法连接 Cobalt（${baseUrl}）`);
  }

  const data = (await response.json().catch(() => null)) as CobaltResponse | null;
  if (!response.ok || !data) throw new Error(`Cobalt 解析失败（HTTP ${response.status}）`);
  if (data.status === 'error') throw new Error(`Cobalt：${data.error?.code ?? '解析失败'}`);

  if (data.status === 'tunnel' || data.status === 'redirect') {
    if (!data.url) throw new Error('Cobalt 未返回媒体地址');
    const filename = data.filename || `x_${tweetId}.mp4`;
    return [{
      id: randomUUID(),
      kind: kindFromFilename(filename),
      filename,
      downloadedBytes: 0,
      sourceUrl: data.url,
    }];
  }

  if (data.status === 'picker') {
    if (!data.picker) throw new Error('Cobalt 未返回媒体列表');
    return data.picker.map((item, index) => {
      const kind = item.type === 'photo' ? 'image' : item.type;
      const fallback = kind === 'image' ? 'jpg' : kind === 'gif' ? 'gif' : 'mp4';
      const extension = extensionFromUrl(item.url, fallback);
      return {
        id: randomUUID(),
        kind,
        filename: `x_${tweetId}_${index + 1}.${extension}`,
        downloadedBytes: 0,
        sourceUrl: item.url,
      };
    });
  }

  throw new Error(`Cobalt 返回了暂不支持的状态：${data.status}`);
}
