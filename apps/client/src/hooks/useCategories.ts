import { useCallback, useState } from 'react';
import { listTweetCategories } from '../api';
import type { TweetCategory } from '../nativeArchive';

export function useCategories() {
  const [categories, setCategories] = useState<TweetCategory[]>([]);
  const [allDownloadedCount, setAllDownloadedCount] = useState(0);
  const [uncategorizedCount, setUncategorizedCount] = useState(0);
  const [revision, setRevision] = useState(0);

  const invalidateArchive = useCallback(() => setRevision((current) => current + 1), []);
  const refreshCategories = useCallback(async () => {
    const result = await listTweetCategories();
    setCategories(result.categories);
    setAllDownloadedCount(result.allTotal);
    setUncategorizedCount(result.uncategorizedTotal);
  }, []);
  const noteCategoryCreated = useCallback((category: TweetCategory) => {
    setCategories((current) => current.some((item) => item.id === category.id) ? current : [...current, category]);
    invalidateArchive();
  }, [invalidateArchive]);

  return {
    categories,
    allDownloadedCount,
    uncategorizedCount,
    revision,
    invalidateArchive,
    refreshCategories,
    noteCategoryCreated,
  };
}
