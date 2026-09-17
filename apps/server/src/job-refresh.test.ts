import { describe, expect, it, vi } from 'vitest';
import { createJobRefresh } from '../../client/src/jobRefresh';
import type { JobList } from '../../client/src/api';

const result = (historyTotal: number, completedToday = 0): JobList => ({ jobs: [], historyTotal, completedToday });
function deferred() {
  let resolve!: (value: JobList) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<JobList>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe('history refresh', () => {
  it('refetches the last valid page after retry removes the sole last-page job', async () => {
    const list = vi.fn().mockResolvedValueOnce(result(25)).mockResolvedValueOnce(result(25, 24));
    const commit = vi.fn();
    await createJobRefresh(list, 25, commit)(1);
    expect(list.mock.calls).toEqual([[{ historyOffset: 25, historyLimit: 25 }], [{ historyOffset: 0, historyLimit: 25 }]]);
    expect(commit).toHaveBeenCalledExactlyOnceWith(result(25, 24), 0);
  });

  it('keeps the newest page when an older request finishes last', async () => {
    const old = deferred();
    const recent = deferred();
    const list = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(recent.promise);
    const commit = vi.fn();
    const refresh = createJobRefresh(list, 25, commit);
    const first = refresh(0);
    const second = refresh(1);
    recent.resolve(result(50, 26)); await second;
    old.resolve(result(49, 25)); await first;
    expect(commit).toHaveBeenCalledExactlyOnceWith(result(50, 26), 1);
  });

  it('ignores a stale failure but reports a current failure', async () => {
    const old = deferred();
    const list = vi.fn().mockReturnValueOnce(old.promise).mockResolvedValueOnce(result(0));
    const refresh = createJobRefresh(list, 25, vi.fn());
    const first = refresh(1);
    await refresh(0);
    old.reject(new Error('stale')); await expect(first).resolves.toBeUndefined();
    list.mockRejectedValueOnce(new Error('offline'));
    await expect(refresh(0)).rejects.toThrow('offline');
  });

  it('does not publish a corrective fetch after the user requests another page', async () => {
    const correction = deferred();
    const list = vi.fn().mockResolvedValueOnce(result(25)).mockReturnValueOnce(correction.promise).mockResolvedValueOnce(result(50));
    const commit = vi.fn();
    const refresh = createJobRefresh(list, 25, commit);
    const first = refresh(2);
    await Promise.resolve();
    await refresh(1);
    correction.resolve(result(25)); await first;
    expect(commit).toHaveBeenCalledExactlyOnceWith(result(50), 1);
  });
});
