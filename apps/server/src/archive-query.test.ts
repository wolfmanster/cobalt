import { describe, expect, it } from 'vitest';
import { listAuthors, listCategorySummaries, listDownloadedPosts, parsePage } from './archive-query.js';
import type { CategorySnapshot } from './categories.js';
import type { DownloadJob, PostMetadata } from './types.js';

function meta(patch: Partial<PostMetadata> = {}): PostMetadata {
  return { authorName: '山间来信', username: 'Mountain', userId: '42', avatarUrl: 'https://cdn.example/a.jpg', text: '湖面的风', language: 'zh', publishedAt: '2026-09-01T00:00:00.000Z', ...patch };
}

function job(patch: Partial<DownloadJob> & Pick<DownloadJob, 'id' | 'tweetId'>): DownloadJob {
  return {
    sourceUrl: `https://x.com/mountain/status/${patch.tweetId}`,
    canonicalUrl: `https://x.com/i/status/${patch.tweetId}`,
    status: 'completed',
    progress: 100,
    media: [],
    attempts: 1,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    completedAt: '2026-09-02T00:00:00.000Z',
    metadata: meta(),
    ...patch,
  };
}

const emptyCategories: CategorySnapshot = { version: 1, categories: [], assignments: [] };

describe('archive query', () => {
  it('keeps only the newest completed record for a tweet id', () => {
    const jobs = [
      job({ id: 'a', tweetId: '1', completedAt: '2026-09-02T00:00:00.000Z', metadata: meta({ text: '旧正文' }) }),
      job({ id: 'b', tweetId: '1', completedAt: '2026-09-03T00:00:00.000Z', metadata: meta({ text: '新正文' }) }),
      job({ id: 'c', tweetId: '1', completedAt: '2026-09-03T00:00:00.000Z', metadata: meta({ text: '同时间较新 id' }) }),
      job({ id: 'queued', tweetId: '2', status: 'queued', progress: 0, completedAt: undefined }),
    ];
    const result = listDownloadedPosts(jobs, emptyCategories, { query: '', offset: 0, limit: 25 });
    expect(result.total).toBe(1);
    expect(result.jobs.map((item) => item.id)).toEqual(['c']);
  });

  it('filters posts by author, category, and text from one snapshot', () => {
    const categories: CategorySnapshot = {
      version: 1,
      categories: [
        { id: 'travel', name: '旅行', normalizedName: '旅行', createdAt: '2026-09-01T00:00:00.000Z' },
      ],
      assignments: [{ tweetId: '1', categoryId: 'travel' }],
    };
    const jobs = [
      job({ id: '1', tweetId: '1', metadata: meta({ text: '山间', username: 'Mountain' }) }),
      job({ id: '2', tweetId: '2', metadata: meta({ text: '城市', authorName: '城里', userId: '', username: 'other' }), completedAt: '2026-09-04T00:00:00.000Z' }),
      job({ id: '3', tweetId: '3', metadata: meta({ text: '未分类', authorName: '第三人', userId: '7', username: 'third' }), completedAt: '2026-09-05T00:00:00.000Z' }),
    ];
    const all = listDownloadedPosts(jobs, categories, { query: '@山', offset: 0, limit: 1 });
    expect(all.total).toBe(1);
    expect(all.jobs).toHaveLength(1);
    expect(all.jobs[0]?.tweetId).toBe('1');
    const page = listDownloadedPosts(jobs, categories, { query: '', offset: 1, limit: 1 });
    expect(page.total).toBe(3);
    expect(page.jobs).toHaveLength(1);
    expect(listDownloadedPosts(jobs, categories, { categoryId: '__uncategorized__', query: '', offset: 0, limit: 25 }).total).toBe(2);
    expect(listDownloadedPosts(jobs, categories, { categoryId: 'travel', query: '', offset: 0, limit: 25 }).jobs.map((item) => item.tweetId)).toEqual(['1']);
    expect(listDownloadedPosts(jobs, categories, { authorKey: 'name:other', query: '', offset: 0, limit: 25 }).jobs.map((item) => item.tweetId)).toEqual(['2']);
  });

  it('searches authors by name or username and paginates the same groups', () => {
    const jobs = [
      job({ id: '1', tweetId: '1', metadata: meta({ authorName: '山间来信', username: 'Mountain', userId: '42' }), completedAt: '2026-09-02T00:00:00.000Z' }),
      job({ id: '1b', tweetId: '1b', metadata: meta({ authorName: '山间来信', username: 'Mountain', userId: '42' }), completedAt: '2026-09-08T00:00:00.000Z' }),
      job({ id: '2', tweetId: '2', metadata: meta({ authorName: '', username: 'River', userId: '', avatarUrl: '  ' }), completedAt: '2026-09-03T00:00:00.000Z' }),
      job({ id: '3', tweetId: '3', metadata: undefined, completedAt: '2026-09-01T00:00:00.000Z' }),
    ];
    const authors = listAuthors(jobs, '@mountain', 0, 25);
    expect(authors.total).toBe(1);
    expect(authors.authors[0]).toMatchObject({ authorKey: 'id:42', tweetCount: 2, authorName: '山间来信', latestDownloadedAt: '2026-09-08T00:00:00.000Z' });
    const page = listAuthors(jobs, '', 1, 1);
    expect(page.total).toBe(3);
    expect(page.authors).toHaveLength(1);
    expect(listAuthors(jobs, '', 0, 25).authors.map((author) => author.authorKey)).toEqual(['id:42', 'name:river', 'unknown']);
    expect(listAuthors(jobs, '', 0, 25).authors[1]).toMatchObject({ authorName: 'River', username: 'River', avatarUrl: '' });
    expect(listAuthors(jobs, '', 0, 25).authors[2]).toMatchObject({ authorName: '作者未知', username: '', avatarUrl: '' });
  });

  it('counts distinct completed tweets and leaves category definitions in created order', () => {
    const categories: CategorySnapshot = {
      version: 1,
      categories: [
        { id: 'b', name: 'Beta', normalizedName: 'beta', createdAt: '2026-09-02T00:00:00.000Z' },
        { id: 'a', name: 'alpha', normalizedName: 'alpha', createdAt: '2026-09-02T00:00:00.000Z' },
      ],
      assignments: [
        { tweetId: '1', categoryId: 'b' },
        { tweetId: '1', categoryId: 'a' },
        { tweetId: 'missing', categoryId: 'b' },
      ],
    };
    const jobs = [
      job({ id: '1', tweetId: '1' }),
      job({ id: '1-old', tweetId: '1', completedAt: '2026-08-01T00:00:00.000Z' }),
      job({ id: '2', tweetId: '2' }),
      job({ id: 'active', tweetId: '3', status: 'downloading', progress: 10, completedAt: undefined }),
    ];
    expect(listCategorySummaries(jobs, categories)).toEqual({
      categories: [
        { id: 'a', name: 'alpha', createdAt: '2026-09-02T00:00:00.000Z', tweetCount: 1 },
        { id: 'b', name: 'Beta', createdAt: '2026-09-02T00:00:00.000Z', tweetCount: 1 },
      ],
      allTotal: 2,
      uncategorizedTotal: 1,
    });
    expect(parsePage('-4', '1000')).toEqual({ offset: 0, limit: 50 });
    expect(parsePage(undefined, undefined)).toEqual({ offset: 0, limit: 25 });
  });
});
