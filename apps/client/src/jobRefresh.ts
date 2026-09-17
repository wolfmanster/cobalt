import type { JobList } from './api';

// Only the newest refresh may publish data, including corrective page fetches.
export function createJobRefresh(
  list: (options: { historyOffset: number; historyLimit: number }) => Promise<JobList>,
  pageSize: number,
  commit: (result: JobList, page: number) => void,
) {
  let generation = 0;
  return async (requestedPage: number) => {
    const request = ++generation;
    let page = requestedPage;
    try {
      while (request === generation) {
        const result = await list({ historyOffset: page * pageSize, historyLimit: pageSize });
        if (request !== generation) return;
        const lastPage = Math.max(0, Math.ceil(result.historyTotal / pageSize) - 1);
        if (page > lastPage) {
          page = lastPage;
          continue;
        }
        commit(result, page);
        return;
      }
    } catch (error) {
      if (request === generation) throw error;
    }
  };
}
