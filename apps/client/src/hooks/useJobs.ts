import { useCallback, useMemo, useRef, useState } from 'react';
import { createJobRefresh } from '../jobRefresh';
import { listJobs } from '../api';
import { usesLocalArchive } from '../platform';
import type { DownloadJob } from '../types';

export const HISTORY_PAGE_SIZE = 25;

export function useJobs(onHistoryChanged: () => void) {
  const [jobs, setJobs] = useState<DownloadJob[]>([]);
  const [historyTotal, setHistoryTotal] = useState(0);
  const [completedToday, setCompletedToday] = useState(0);
  const [historyPage, setHistoryPage] = useState(0);
  const historyPageRef = useRef(0);
  const previousHistoryTotal = useRef<number | null>(null);

  const loadPage = useMemo(() => createJobRefresh(listJobs, HISTORY_PAGE_SIZE, (result, page) => {
    if (usesLocalArchive && previousHistoryTotal.current !== null && previousHistoryTotal.current !== result.historyTotal) onHistoryChanged();
    previousHistoryTotal.current = result.historyTotal;
    setJobs(result.jobs);
    setHistoryTotal(result.historyTotal);
    setCompletedToday(result.completedToday);
    historyPageRef.current = page;
    setHistoryPage(page);
  }), [onHistoryChanged]);

  const refreshJobs = useCallback(() => loadPage(historyPageRef.current), [loadPage]);
  const resetHistoryPage = useCallback(() => {
    historyPageRef.current = 0;
    setHistoryPage(0);
  }, []);
  const showHistoryPage = useCallback((requestedPage: number) => {
    const lastPage = Math.max(0, Math.ceil(historyTotal / HISTORY_PAGE_SIZE) - 1);
    historyPageRef.current = Math.min(Math.max(requestedPage, 0), lastPage);
    return refreshJobs();
  }, [historyTotal, refreshJobs]);

  return { jobs, historyTotal, completedToday, historyPage, refreshJobs, resetHistoryPage, showHistoryPage };
}
