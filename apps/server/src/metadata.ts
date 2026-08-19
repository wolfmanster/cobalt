import type { PostMetadata } from './types.js';

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36';

function syndicationToken(id: string): string {
  return ((Number(id) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, '');
}

interface SyndicationTweet {
  text?: string;
  lang?: string;
  created_at?: string;
  user?: {
    id_str?: string;
    name?: string;
    screen_name?: string;
    profile_image_url_https?: string;
    protected?: boolean;
  };
}

export async function fetchPostMetadata(tweetId: string, signal?: AbortSignal): Promise<PostMetadata> {
  const url = new URL('https://cdn.syndication.twimg.com/tweet-result');
  url.searchParams.set('id', tweetId);
  url.searchParams.set('token', syndicationToken(tweetId));
  url.searchParams.set('lang', 'zh-cn');

  const response = await fetch(url, {
    headers: { 'user-agent': USER_AGENT, accept: 'application/json' },
    signal,
  });

  if (!response.ok) {
    throw new Error(`帖子元数据获取失败（HTTP ${response.status}）`);
  }

  const data = (await response.json()) as SyndicationTweet;
  if (!data.user || data.user.protected || !data.user.id_str || !data.user.screen_name) {
    throw new Error('帖子不存在、不是公开帖子，或暂时无法读取');
  }

  return {
    authorName: data.user.name ?? data.user.screen_name,
    username: data.user.screen_name,
    userId: data.user.id_str,
    avatarUrl: (data.user.profile_image_url_https ?? '').replace('_normal.', '_400x400.'),
    text: data.text ?? '',
    language: data.lang ?? 'und',
    publishedAt: data.created_at ? new Date(data.created_at).toISOString() : '',
  };
}
