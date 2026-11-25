import type { CategorySnapshot } from './categories.js';
import type { DownloadJob } from './types.js';

export interface PostListOptions {
  authorKey?: string;
  categoryId?: string;
  query?: string;
  offset: number;
  limit: number;
}

export interface AuthorSummary {
  authorKey: string;
  authorName: string;
  username: string;
  avatarUrl: string;
  tweetCount: number;
  latestDownloadedAt: string;
}

export interface CategorySummary {
  id: string;
  name: string;
  createdAt: string;
  tweetCount: number;
}

export function parsePage(offsetRaw: unknown, limitRaw: unknown): { offset: number; limit: number } {
  const offsetNumber = Number.parseInt(String(offsetRaw ?? '0'), 10);
  const offset = Number.isFinite(offsetNumber) ? Math.max(0, offsetNumber) : 0;
  const limitNumber = Number.parseInt(String(limitRaw ?? ''), 10);
  const limit = Number.isFinite(limitNumber) && limitNumber > 0 ? Math.min(50, limitNumber) : 25;
  return { offset, limit };
}

export function normalizeArchiveQuery(raw: string | undefined): string {
  return (raw ?? '').trim().replace(/^@/, '').toLowerCase();
}

export function authorKeyOf(job: DownloadJob): string {
  const userId = job.metadata?.userId?.trim() ?? '';
  if (userId) return `id:${userId}`;
  const username = job.metadata?.username?.trim() ?? '';
  if (username) return `name:${username.toLowerCase()}`;
  return 'unknown';
}

function completionStamp(job: DownloadJob): string {
  return job.completedAt ?? job.createdAt;
}

function compareCompletedDesc(left: DownloadJob, right: DownloadJob): number {
  const stamps = completionStamp(right).localeCompare(completionStamp(left));
  if (stamps) return stamps;
  return right.id.localeCompare(left.id);
}

function latestCompleted(jobs: DownloadJob[]): DownloadJob[] {
  const best = new Map<string, DownloadJob>();
  for (const job of jobs) {
    if (job.status !== 'completed') continue;
    const current = best.get(job.tweetId);
    if (!current || compareCompletedDesc(job, current) < 0) best.set(job.tweetId, job);
  }
  return [...best.values()];
}

function matchesCategory(snapshot: CategorySnapshot, tweetId: string, categoryId: string | undefined): boolean {
  if (!categoryId) return true;
  const assigned = snapshot.assignments.some((assignment) => assignment.tweetId === tweetId && assignment.categoryId === categoryId);
  if (categoryId === '__uncategorized__') {
    return !snapshot.assignments.some((assignment) => assignment.tweetId === tweetId);
  }
  return assigned;
}

function postMatches(job: DownloadJob, query: string): boolean {
  if (!query) return true;
  return [job.metadata?.text ?? '', job.metadata?.authorName ?? '', job.metadata?.username ?? '', job.tweetId]
    .some((field) => field.toLowerCase().includes(query));
}

export function listDownloadedPosts(jobs: DownloadJob[], snapshot: CategorySnapshot, options: PostListOptions) {
  const query = normalizeArchiveQuery(options.query);
  const filtered = latestCompleted(jobs)
    .filter((job) => !options.authorKey || authorKeyOf(job) === options.authorKey)
    .filter((job) => matchesCategory(snapshot, job.tweetId, options.categoryId || undefined))
    .filter((job) => postMatches(job, query))
    .sort(compareCompletedDesc);
  return { jobs: filtered.slice(options.offset, options.offset + options.limit), total: filtered.length };
}

export function listAuthors(jobs: DownloadJob[], rawQuery: string | undefined, offset: number, limit: number) {
  const query = normalizeArchiveQuery(rawQuery);
  const groups = new Map<string, DownloadJob[]>();
  for (const job of jobs) {
    if (job.status !== 'completed') continue;
    const key = authorKeyOf(job);
    const group = groups.get(key);
    if (group) group.push(job);
    else groups.set(key, [job]);
  }
  const authors: AuthorSummary[] = [];
  for (const [authorKey, group] of groups) {
    const matches = !query || group.some((job) => {
      const name = (job.metadata?.authorName ?? '').toLowerCase();
      const username = (job.metadata?.username ?? '').toLowerCase();
      return name.includes(query) || username.includes(query);
    });
    if (!matches) continue;
    const latest = [...group].sort(compareCompletedDesc)[0]!;
    const latestDownloadedAt = group.map(completionStamp).sort().at(-1)!;
    authors.push({
      authorKey,
      authorName: latest.metadata?.authorName?.trim() || latest.metadata?.username?.trim() || '作者未知',
      username: latest.metadata?.username?.trim() || '',
      avatarUrl: latest.metadata?.avatarUrl?.trim() || '',
      tweetCount: new Set(group.map((job) => job.tweetId)).size,
      latestDownloadedAt,
    });
  }
  authors.sort((left, right) => right.latestDownloadedAt.localeCompare(left.latestDownloadedAt) || left.authorKey.localeCompare(right.authorKey));
  return { authors: authors.slice(offset, offset + limit), total: authors.length };
}

export function listCategorySummaries(jobs: DownloadJob[], snapshot: CategorySnapshot) {
  const completedTweetIds = new Set(jobs.filter((job) => job.status === 'completed').map((job) => job.tweetId));
  const assignedTweets = new Set<string>();
  const counts = new Map<string, Set<string>>();
  for (const assignment of snapshot.assignments) {
    if (!completedTweetIds.has(assignment.tweetId)) continue;
    assignedTweets.add(assignment.tweetId);
    const tweets = counts.get(assignment.categoryId) ?? new Set<string>();
    tweets.add(assignment.tweetId);
    counts.set(assignment.categoryId, tweets);
  }
  const categories: CategorySummary[] = [...snapshot.categories]
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.name.toLowerCase().localeCompare(right.name.toLowerCase()) || left.id.localeCompare(right.id))
    .map((category) => ({
      id: category.id,
      name: category.name,
      createdAt: category.createdAt,
      tweetCount: counts.get(category.id)?.size ?? 0,
    }));
  let uncategorizedTotal = 0;
  for (const tweetId of completedTweetIds) if (!assignedTweets.has(tweetId)) uncategorizedTotal += 1;
  return { categories, allTotal: completedTweetIds.size, uncategorizedTotal };
}
