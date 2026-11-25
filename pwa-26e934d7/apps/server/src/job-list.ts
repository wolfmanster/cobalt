import type { DownloadJob } from './types.js';

export function jobList(jobs: DownloadJob[], offset: number, limit: number, now = new Date()) {
  const terminal = new Set(['completed', 'failed', 'canceled']);
  const active = jobs.filter(job => !terminal.has(job.status));
  const history = jobs.filter(job => terminal.has(job.status));
  const today = now.toISOString().slice(0, 10);
  return {
    jobs: [...active, ...history.slice(offset, offset + limit)],
    historyTotal: history.length,
    completedToday: jobs.filter(job => job.status === 'completed' && job.completedAt?.slice(0, 10) === today).length,
  };
}
