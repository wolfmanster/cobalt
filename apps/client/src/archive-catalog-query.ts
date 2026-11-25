import type { ArchiveCatalog } from './archive-catalog';
import type { DownloadJob } from './types';

function downloadedAt(job: DownloadJob) { return job.completedAt ?? job.createdAt; }
export function archivedPosts(catalog: ArchiveCatalog) {
  return [...catalog.posts].sort((a, b) => Date.parse(downloadedAt(b)) - Date.parse(downloadedAt(a)) || b.id.localeCompare(a.id));
}
function authorKey(job: DownloadJob) {
  const userId = job.metadata?.userId?.trim();
  const username = job.metadata?.username?.trim();
  return userId ? 'id:' + userId : username ? 'name:' + username.toLowerCase() : 'unknown';
}
function normalized(value: string) { return value.trim().replace(/^@/, '').toLowerCase(); }

export function catalogPosts(catalog: ArchiveCatalog, options: { query: string; offset: number; limit: number; authorKey?: string; categoryId?: string }) {
  const query = normalized(options.query);
  const posts = archivedPosts(catalog).filter((job) => {
    if (options.authorKey && options.authorKey !== authorKey(job)) return false;
    if (options.categoryId === '__uncategorized__' && job.categoryIds.length) return false;
    if (options.categoryId && options.categoryId !== '__uncategorized__' && !job.categoryIds.includes(options.categoryId)) return false;
    return [job.tweetId, job.metadata?.text, job.metadata?.authorName, job.metadata?.username]
      .some((value) => value?.toLowerCase().includes(query));
  });
  return { jobs: posts.slice(options.offset, options.offset + options.limit), total: posts.length };
}

export function catalogAuthors(catalog: ArchiveCatalog, options: { query: string; offset: number; limit: number }) {
  const query = normalized(options.query);
  const groups = new Map<string, ReturnType<typeof archivedPosts>>();
  for (const job of archivedPosts(catalog)) {
    const key = authorKey(job);
    const group = groups.get(key) ?? [];
    group.push(job);
    groups.set(key, group);
  }
  const authors = [...groups].filter(([, group]) => !query || group.some((job) =>
    [job.metadata?.authorName, job.metadata?.username].some((name) => name?.toLowerCase().includes(query))))
    .map(([authorKey, group]) => {
      const latest = group[0];
      return { authorKey, authorName: latest.metadata?.authorName || latest.metadata?.username || '作者未知',
        username: latest.metadata?.username ?? '', avatarUrl: latest.metadata?.avatarUrl ?? '',
        latestDownloadedAt: downloadedAt(latest), tweetCount: group.length };
    });
  return { authors: authors.slice(options.offset, options.offset + options.limit), total: authors.length };
}

export function catalogCategories(catalog: ArchiveCatalog) {
  const counts = new Map<string, number>();
  let uncategorizedTotal = 0;
  for (const job of catalog.posts) {
    if (job.categoryIds.length === 0) uncategorizedTotal++;
    for (const id of job.categoryIds) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return { allTotal: catalog.posts.length, uncategorizedTotal,
    categories: catalog.categories.map((category) => ({ ...category, tweetCount: counts.get(category.id) ?? 0 })) };
}
