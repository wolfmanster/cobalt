import type { DownloadJob } from './types.js';

export function jobList(jobs: DownloadJob[], offset: number, limit: number, now = new Date()) {
  const terminal = new Set(['completed', 'failed', 'canceled']);
  const active = jobs.filter(job => !terminal.has(job.status));
  const archived = new Set<string>();
  const history = jobs.filter((job) => {
    if (!terminal.has(job.status)) return false;
    if (job.status !== 'completed') return true;
    if (archived.has(job.tweetId)) return false;
    archived.add(job.tweetId);
    return true;
  });
  const today = now.toISOString().slice(0, 10);
  return {
    jobs: [...active, ...history.slice(offset, offset + limit)],
    historyTotal: history.length,
    completedToday: history.filter(job => job.status === 'completed' && job.completedAt?.slice(0, 10) === today).length,
  };
}
