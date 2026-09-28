import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowLeft, Search, X } from 'lucide-react';
import { listAuthors, listDownloadedPosts } from './api';
import type { DownloadJob } from './types';
import type { DownloadedAuthor } from './nativeArchive';

const PAGE_SIZE = 25;
const RECENT_DATE_FORMATTER = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'short', day: 'numeric' });

type Page<T> = { items: T[]; total: number };

function useDebouncedValue(value: string) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), 250);
    return () => window.clearTimeout(timer);
  }, [value]);
  return debounced;
}

function AuthorAvatar({ url, name }: { url: string; name: string }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [url]);
  return url && !failed
    ? <img className="archive-avatar" src={url} alt="" loading="lazy" onError={() => setFailed(true)} />
    : <span className="archive-avatar archive-avatar-fallback" aria-hidden="true">{name === '作者未知' ? '?' : name.slice(0, 1).toUpperCase()}</span>;
}

function PageNav({ page, total, onPage }: { page: number; total: number; onPage: (page: number) => void }) {
  if (total <= PAGE_SIZE) return null;
  return <nav className="history-pagination" aria-label="浏览结果分页">
    <button type="button" onClick={() => onPage(page - 1)} disabled={page === 0}>上一页</button>
    <span>第 {page + 1} / {Math.ceil(total / PAGE_SIZE)} 页</span>
    <button type="button" onClick={() => onPage(page + 1)} disabled={(page + 1) * PAGE_SIZE >= total}>下一页</button>
  </nav>;
}

function SearchBox({ value, onChange, inputRef }: { value: string; onChange: (value: string) => void; inputRef: React.RefObject<HTMLInputElement | null> }) {
  return <div className="archive-search">
    <Search size={17} aria-hidden="true" />
    <input ref={inputRef} type="search" value={value} onChange={(event) => onChange(event.target.value)} placeholder="搜索作者名称、@用户名或推文内容" aria-label="搜索作者和推文内容" />
    {value && <button type="button" onClick={() => { onChange(''); inputRef.current?.focus(); }} aria-label="清除搜索"><X size={15} /></button>}
  </div>;
}

function EmptyResults({ searching, label }: { searching: boolean; label: string }) {
  return <div className="archive-empty" role="status">{searching ? `没有匹配的${label}` : `还没有${label}`}</div>;
}

function formatRecent(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '时间未知' : RECENT_DATE_FORMATTER.format(date);
}

export function HistoryBrowser({ mode, revision, renderJob, onError }: {
  mode: 'authors' | 'search';
  revision: number;
  renderJob: (job: DownloadJob) => ReactNode;
  onError: (message: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [postPage, setPostPage] = useState(0);
  const [authorPage, setAuthorPage] = useState(0);
  const [detailPage, setDetailPage] = useState(0);
  const [posts, setPosts] = useState<Page<DownloadJob> | null>(null);
  const [authors, setAuthors] = useState<Page<DownloadedAuthor> | null>(null);
  const [detailPosts, setDetailPosts] = useState<Page<DownloadJob> | null>(null);
  const [detail, setDetail] = useState<DownloadedAuthor | null>(null);
  const detailScroll = useRef<HTMLDivElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const debouncedQuery = useDebouncedValue(query);
  const searching = mode === 'search' && Boolean(query.trim());

  useEffect(() => { if (mode === 'search') searchInput.current?.focus(); }, [mode]);

  useEffect(() => {
    if (mode !== 'search') return;
    let live = true;
    setPosts(null);
    if (!query.trim() || query !== debouncedQuery) return () => { live = false; };
    void listDownloadedPosts({ query: debouncedQuery, offset: postPage * PAGE_SIZE, limit: PAGE_SIZE })
      .then((result) => {
        if (!live) return;
        const lastPage = Math.max(0, Math.ceil(result.total / PAGE_SIZE) - 1);
        if (postPage > lastPage) { setPostPage(lastPage); return; }
        setPosts({ items: result.jobs, total: result.total });
      })
      .catch((error) => { if (live) onError(error instanceof Error ? error.message : '无法读取已下载推文'); });
    return () => { live = false; };
  }, [mode, query, debouncedQuery, postPage, revision, onError]);

  useEffect(() => {
    let live = true;
    setAuthors(null);
    if (mode === 'search' && (!query.trim() || query !== debouncedQuery)) return () => { live = false; };
    void listAuthors({ query: mode === 'search' ? debouncedQuery : '', offset: authorPage * PAGE_SIZE, limit: PAGE_SIZE })
      .then((result) => {
        if (!live) return;
        const lastPage = Math.max(0, Math.ceil(result.total / PAGE_SIZE) - 1);
        if (authorPage > lastPage) { setAuthorPage(lastPage); return; }
        setAuthors({ items: result.authors, total: result.total });
      })
      .catch((error) => { if (live) onError(error instanceof Error ? error.message : '无法读取作者列表'); });
    return () => { live = false; };
  }, [mode, query, debouncedQuery, authorPage, revision, onError]);

  useEffect(() => {
    if (!detail) return;
    let live = true;
    setDetailPosts(null);
    void listDownloadedPosts({ authorKey: detail.authorKey, query: '', offset: detailPage * PAGE_SIZE, limit: PAGE_SIZE })
      .then((result) => {
        if (!live) return;
        const lastPage = Math.max(0, Math.ceil(result.total / PAGE_SIZE) - 1);
        if (detailPage > lastPage) { setDetailPage(lastPage); return; }
        setDetailPosts({ items: result.jobs, total: result.total });
      })
      .catch((error) => { if (live) onError(error instanceof Error ? error.message : '无法读取作者推文'); });
    return () => { live = false; };
  }, [detail, detailPage, revision, onError]);

  useEffect(() => {
    if (!detail) return;
    const browserWindow = window as Window & { __cobaltGoBack?: () => boolean };
    browserWindow.__cobaltGoBack = () => { setDetail(null); return true; };
    return () => { delete browserWindow.__cobaltGoBack; };
  }, [detail]);

  function openAuthor(author: DownloadedAuthor) {
    setDetail(author);
    setDetailPage(0);
    detailScroll.current?.scrollTo(0, 0);
  }

  return <>
    <div className="archive-browser">
      {mode === 'search' && <>
        <SearchBox value={query} inputRef={searchInput} onChange={(value) => { setQuery(value); setAuthorPage(0); setPostPage(0); }} />
        {!searching && <div className="archive-empty">输入作者名称、@用户名或推文正文开始搜索</div>}
      </>}
      {searching && <section className="archive-result-section" aria-label="推文内容结果">
        <h3>推文内容</h3>
        <p className="archive-result-count">{posts ? `找到 ${posts.total} 条已下载推文` : '正在查找推文…'}</p>
        {posts && (posts.items.length
          ? <div className="job-list archive-post-list">{posts.items.map((job) => <div key={job.id}>{renderJob(job)}</div>)}</div>
          : <EmptyResults searching label="推文" />)}
        {posts && <PageNav page={postPage} total={posts.total} onPage={setPostPage} />}
      </section>}

      {(mode === 'authors' || searching) && <section className="archive-result-section" aria-label="作者结果">
      {mode === 'search' && <h3>作者</h3>}
      <p className="archive-result-count">{authors ? `找到 ${authors.total} 位作者` : '正在查找作者…'}</p>
      {authors && (authors.items.length
        ? <div className="archive-author-list">{authors.items.map((author) => <button className="archive-author" type="button" key={author.authorKey} onClick={() => openAuthor(author)}>
            <AuthorAvatar url={author.avatarUrl} name={author.authorName} />
            <span className="archive-author-main"><strong>{author.authorName}</strong><small>{author.username ? `@${author.username}` : '用户名未知'}</small></span>
            <span className="archive-author-stats"><small>最近 {formatRecent(author.latestDownloadedAt)}</small></span>
          </button>)}</div>
        : <EmptyResults searching={searching} label="作者" />)}
      {authors && <PageNav page={authorPage} total={authors.total} onPage={setAuthorPage} />}
      </section>}
    </div>

    {detail && <div className="archive-detail-screen" ref={detailScroll} role="region" aria-label={`${detail.authorName}的已下载推文`}>
      <header className="archive-detail-header">
        <button className="archive-back" type="button" onClick={() => setDetail(null)} aria-label="返回作者列表"><ArrowLeft size={21} /></button>
        <span>作者的已下载推文</span>
      </header>
      <div className="archive-detail-body">
        <div className="archive-detail-profile">
          <AuthorAvatar url={detail.avatarUrl} name={detail.authorName} />
          <div><h2>{detail.authorName}</h2><p>{detail.username ? `@${detail.username}` : '用户名未知'}</p></div>
        </div>
        <p className="archive-result-count">{detailPosts ? `找到 ${detailPosts.total} 条推文` : '正在查找推文…'}</p>
        {detailPosts && (detailPosts.items.length
          ? <div className="job-list archive-post-list">{detailPosts.items.map((job) => <div key={job.id}>{renderJob(job)}</div>)}</div>
          : <EmptyResults searching={false} label="推文" />)}
        {detailPosts && <PageNav page={detailPage} total={detailPosts.total} onPage={(page) => { setDetailPage(page); detailScroll.current?.scrollTo(0, 0); }} />}
      </div>
    </div>}
  </>;
}
