import { useEffect, useRef, useState, type ReactNode } from 'react';
import { FolderPlus, Pencil, Search, Trash2, X } from 'lucide-react';
import { listDownloadedPosts } from './api';
import { CategorySelectionBar } from './components/CategorySelectionBar';
import type { DownloadJob } from './types';
import type { TweetCategory } from './nativeArchive';

const PAGE_SIZE = 25;
export const ALL_DOWNLOADED_CATEGORY = '__all__';
export const UNCATEGORIZED_CATEGORY = '__uncategorized__';

function PageNav({ page, total, onPage }: { page: number; total: number; onPage: (page: number) => void }) {
  if (total <= PAGE_SIZE) return null;
  return <nav className="history-pagination" aria-label="分类推文分页">
    <button type="button" onClick={() => onPage(page - 1)} disabled={page === 0}>上一页</button>
    <span>第 {page + 1} / {Math.ceil(total / PAGE_SIZE)} 页</span>
    <button type="button" onClick={() => onPage(page + 1)} disabled={(page + 1) * PAGE_SIZE >= total}>下一页</button>
  </nav>;
}

export function CategoryBrowser({
  categories,
  allTotal,
  uncategorizedTotal,
  revision,
  renderJob,
  onError,
  selectionMode,
  selectedTweetIds,
  onStartSelection,
  onStopSelection,
  onSelectPage,
  onAssign,
  onScopeChange,
  onCreate,
  onRename,
  onDelete,
}: {
  categories: TweetCategory[];
  allTotal: number;
  uncategorizedTotal: number;
  revision: number;
  renderJob: (job: DownloadJob) => ReactNode;
  onError: (message: string) => void;
  selectionMode: boolean;
  selectedTweetIds: Set<string>;
  onStartSelection: () => void;
  onStopSelection: () => void;
  onSelectPage: (tweetIds: string[]) => void;
  onAssign: () => void;
  onScopeChange: () => void;
  onCreate: () => void;
  onRename: (category: TweetCategory) => void;
  onDelete: (category: TweetCategory) => void;
}) {
  const [selectedCategoryId, setSelectedCategoryId] = useState(ALL_DOWNLOADED_CATEGORY);
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [page, setPage] = useState(0);
  const [result, setResult] = useState<{ jobs: DownloadJob[]; total: number } | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(query), 250);
    return () => window.clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    if (selectedCategoryId === ALL_DOWNLOADED_CATEGORY || selectedCategoryId === UNCATEGORIZED_CATEGORY) return;
    if (categories.some((category) => category.id === selectedCategoryId)) return;
    setSelectedCategoryId(ALL_DOWNLOADED_CATEGORY);
    setPage(0);
    setQuery('');
    setDebouncedQuery('');
    onScopeChange();
  }, [categories, selectedCategoryId, onScopeChange]);

  useEffect(() => {
    let live = true;
    setResult(null);
    const categoryId = selectedCategoryId === ALL_DOWNLOADED_CATEGORY ? undefined : selectedCategoryId;
    void listDownloadedPosts({ categoryId, query: debouncedQuery, offset: page * PAGE_SIZE, limit: PAGE_SIZE })
      .then((posts) => {
        if (!live) return;
        const lastPage = Math.max(0, Math.ceil(posts.total / PAGE_SIZE) - 1);
        if (page > lastPage) { setPage(lastPage); return; }
        setResult(posts);
      })
      .catch((error) => { if (live) onError(error instanceof Error ? error.message : '无法读取分类推文'); });
    return () => { live = false; };
  }, [selectedCategoryId, debouncedQuery, page, revision, onError]);

  function changeCategory(id: string) {
    if (selectedCategoryId === id) return;
    setSelectedCategoryId(id);
    setQuery('');
    setDebouncedQuery('');
    setPage(0);
    onScopeChange();
  }

  function changeQuery(value: string) {
    setQuery(value);
    setPage(0);
    onScopeChange();
  }

  const pageTweetIds = [...new Set((result?.jobs ?? []).filter((job) => job.status === 'completed').map((job) => job.tweetId))];

  return <div className="category-browser">
    <div className="category-browser-heading">
      <div><h3>推文分类</h3><p>一条推文可同时归入多个分类</p></div>
      <button type="button" className="category-primary-button" onClick={onCreate}><FolderPlus size={16} />新建分类</button>
    </div>
    <div className="category-picker" role="tablist" aria-label="选择推文分类">
      <button type="button" role="tab" aria-selected={selectedCategoryId === ALL_DOWNLOADED_CATEGORY} className={selectedCategoryId === ALL_DOWNLOADED_CATEGORY ? 'selected' : ''} onClick={() => changeCategory(ALL_DOWNLOADED_CATEGORY)}>
        <span>全部已下载</span><b>{allTotal}</b>
      </button>
      <button type="button" role="tab" aria-selected={selectedCategoryId === UNCATEGORIZED_CATEGORY} className={selectedCategoryId === UNCATEGORIZED_CATEGORY ? 'selected' : ''} onClick={() => changeCategory(UNCATEGORIZED_CATEGORY)}>
        <span>未分类</span><b>{uncategorizedTotal}</b>
      </button>
      {categories.map((category) => <div className={`category-picker-item ${selectedCategoryId === category.id ? 'selected' : ''}`} key={category.id}>
        <button type="button" role="tab" aria-selected={selectedCategoryId === category.id} onClick={() => changeCategory(category.id)}>
          <span>{category.name}</span><b>{category.tweetCount}</b>
        </button>
        <button type="button" aria-label={`重命名分类 ${category.name}`} title="重命名" onClick={() => onRename(category)}><Pencil size={14} /></button>
        <button type="button" aria-label={`删除分类 ${category.name}`} title="删除" onClick={() => onDelete(category)}><Trash2 size={14} /></button>
      </div>)}
    </div>

    <div className="category-list-heading">
      <h4>{selectedCategoryId === ALL_DOWNLOADED_CATEGORY ? '全部已下载' : selectedCategoryId === UNCATEGORIZED_CATEGORY ? '未分类' : categories.find((item) => item.id === selectedCategoryId)?.name ?? '分类'}</h4>
      <div className="archive-search category-search"><Search size={17} aria-hidden="true" />
        <input ref={searchRef} type="search" value={query} onChange={(event) => changeQuery(event.target.value)} placeholder="搜索推文内容或作者" aria-label="在当前分类中搜索" />
        {query && <button type="button" onClick={() => { changeQuery(''); searchRef.current?.focus(); }} aria-label="清除搜索"><X size={15} /></button>}
      </div>
    </div>
    <p className="archive-result-count">{result ? `找到 ${result.total} 条已下载推文` : '正在加载推文…'}</p>
    <CategorySelectionBar currentTweetIds={pageTweetIds} selectionMode={selectionMode} selectedCount={selectedTweetIds.size}
      onStart={onStartSelection} onStop={onStopSelection} onSelectPage={onSelectPage} onAssign={onAssign} />
    {result && (result.jobs.length
      ? <div className="job-list archive-post-list">{result.jobs.map(renderJob)}</div>
      : <div className="archive-empty" role="status">{debouncedQuery ? '没有匹配的推文' : '这个分类还没有推文'}</div>)}
    {!result && <div className="archive-loading" role="status">正在加载分类推文…</div>}
    {result && <PageNav page={page} total={result.total} onPage={setPage} />}
  </div>;
}
