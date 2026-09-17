import { expect, it } from 'vitest';
import { jobList } from './job-list.js';
import type { DownloadJob } from './types.js';

it('counts all completed jobs today independently of page and excludes other statuses/days', () => {
  const now = new Date('2026-09-17T08:00:00Z');
  const completed = Array.from({ length: 26 }, (_, id) => ({
    id: String(id), status: 'completed', completedAt: now.toISOString(),
  } as DownloadJob));
  const jobs = [...completed,
    { id: 'failed', status: 'failed', completedAt: now.toISOString() } as DownloadJob,
    { id: 'yesterday', status: 'completed', completedAt: '2026-09-16T08:00:00Z' } as DownloadJob,
    { id: 'active', status: 'downloading' } as DownloadJob];
  const first = jobList(jobs, 0, 25, now);
  const second = jobList(jobs, 25, 25, now);
  expect(first.completedToday).toBe(26);
  expect(second.completedToday).toBe(26);
  expect(first.historyTotal).toBe(28);
  expect(first.jobs).toHaveLength(26);
  expect(second.jobs).toHaveLength(4);
  expect(second.jobs[0]?.id).toBe('active');
});
