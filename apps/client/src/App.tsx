import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createJobRefresh } from './jobRefresh';
import { HistoryBrowser } from './HistoryBrowser';
import { Capacitor } from '@capacitor/core';
import {
  Archive,
  ArrowDownToLine,
  Check,
  CircleAlert,
  Clock3,
  FileText,
  FolderCheck,
  FolderOpen,
  Home,
  History,
  Image as ImageIcon,
  Link2,
  LoaderCircle,
  Pause,
  RotateCcw,
  Search,
  ShieldCheck,
  Trash2,
  Upload,
  Video,
  X,
} from 'lucide-react';
import { cancelJob, clearHistory, clearXSession, consumeSharedContent, createJobs, getDownloadFolder, getHealth, getXSessionStatus, listJobs, openMedia, readClipboardText, retryJob, selectDownloadFolder, setDownloadPath, startXLogin, subscribeJobs, subscribeSharedContent, xLoginSupported } from './api';
import type { DownloadJob, JobStatus, MediaItem } from './types';

const HISTORY_PAGE_SIZE = 25;

const STATUS: Record<JobStatus, { label: string; className: string }> = {
  queued: { label: '等待中', className: 'neutral' },
  resolving: { label: '解析帖子', className: 'active' },
  downloading: { label: '下载中', className: 'active' },
  completed: { label: '已完成', className: 'success' },
  failed: { label: '失败', className: 'danger' },
  canceled: { label: '已取消', className: 'neutral' },
};

function extractUrls(text: string) {
  return [...new Set((text.match(/https:\/\/[^\s,;"'<>]+/gi) ?? []).map((url) => url.replace(/[)\].，。！？]+$/u, '')))];
}

function formatBytes(bytes?: number) {
  if (bytes === undefined) return '大小未知';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

function formatDate(value?: string) {
  if (!value) return '时间未知';
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

function statusIcon(status: JobStatus) {
  if (status === 'completed') return <Check size={13} />;
  if (status === 'failed') return <CircleAlert size={13} />;
  if (status === 'downloading' || status === 'resolving') return <LoaderCircle className="spin" size={13} />;
  return <Clock3 size={13} />;
}

function revealVideoPreview(video: HTMLVideoElement) {
  if (video.currentTime > 0 || !Number.isFinite(video.duration) || video.duration <= 0) return;
  video.currentTime = Math.min(0.05, video.duration / 2);
}

function MediaPreview({ media }: { media: MediaItem }) {
  const previewUrl = Capacitor.convertFileSrc(media.previewUrl);
  if (media.kind === 'image' || media.kind === 'gif') {
    return <img src={previewUrl} alt={media.filename} loading="lazy" />;
  }
  return (
    <video
      src={previewUrl}
      controls
      playsInline
      preload="metadata"
      onLoadedMetadata={(event) => revealVideoPreview(event.currentTarget)}
    />
  );
}

function JobCard({ job, onAction, onOpenMedia, presentation = 'queue' }: { job: DownloadJob; onAction: (action: 'cancel' | 'retry', id: string) => void; onOpenMedia: (id: string) => void; presentation?: 'queue' | 'history' }) {
  const [avatarFailed, setAvatarFailed] = useState(false);
  const [activeMediaIndex, setActiveMediaIndex] = useState(0);
  const touchStartX = useRef<number | null>(null);
  useEffect(() => setAvatarFailed(false), [job.metadata?.avatarUrl]);
  useEffect(() => setActiveMediaIndex(0), [job.id, job.media.map((media) => media.id).join('|')]);
  const active = ['queued', 'resolving', 'downloading'].includes(job.status);
  const complete = job.status === 'completed';
  const historical = presentation === 'history';
  const totalSize = job.media.reduce((sum, item) => sum + (item.size ?? 0), 0);

  return (
    <article className={`job-card ${active ? 'is-active' : ''} ${historical ? 'is-history-post' : ''}`}>
      <div className="job-main">
        <div className="author-row">
          <div className="avatar-wrap">
            {job.metadata?.avatarUrl && !avatarFailed ? (
              <img className="avatar" src={job.metadata.avatarUrl} alt="" loading="lazy" onError={() => setAvatarFailed(true)} />
            ) : (
              <div className="avatar placeholder-avatar"><span>𝕏</span></div>
            )}
            {active && <span className="live-dot" />}
          </div>
          <div className="author-copy">
            <div className="author-name">
              {job.metadata?.authorName ?? (job.status === 'resolving' ? '正在读取帖子…' : 'X 帖子')}
              {job.metadata && <span>@{job.metadata.username}</span>}
            </div>
            <div className="post-meta">
              {!historical && <span>推文 ID {job.tweetId}</span>}
              {!historical && job.metadata?.language && <span>{job.metadata.language.toUpperCase()}</span>}
              <span className="post-date">{formatDate(job.metadata?.publishedAt ?? job.createdAt)}</span>
            </div>
          </div>
          <span className={`status ${STATUS[job.status].className}`}>
            {statusIcon(job.status)} {STATUS[job.status].label}
          </span>
        </div>

        {job.metadata?.text && <p className="post-text">{job.metadata.text}</p>}
        {job.error && <div className="error-message"><CircleAlert size={15} />{job.error}</div>}

        {active && (
          <div className="progress-block">
            <div className="progress-copy">
              <span>{job.status === 'queued' ? '等待空闲解析槽位' : job.status === 'resolving' ? '正在并行获取元数据与媒体' : `正在并行保存 ${job.media.length} 个媒体文件`}</span>
              <strong>{job.progress}%</strong>
            </div>
            <div className="progress-track"><span style={{ width: `${job.progress}%` }} /></div>
          </div>
        )}

        {complete && job.media.length > 0 && (
          <div className="media-carousel" aria-label={`此推文的 ${job.media.length} 个媒体文件`}>
            <div
              className="media-viewport"
              onTouchStart={(event) => { touchStartX.current = event.touches[0]?.clientX ?? null; }}
              onTouchEnd={(event) => {
                const startX = touchStartX.current;
                touchStartX.current = null;
                if (startX === null || job.media.length < 2) return;
                const delta = event.changedTouches[0].clientX - startX;
                if (Math.abs(delta) < 40) return;
                setActiveMediaIndex((index) => Math.max(0, Math.min(job.media.length - 1, index + (delta < 0 ? 1 : -1))));
              }}
              onTouchCancel={() => { touchStartX.current = null; }}
            >
              <div className="media-track" style={{ transform: `translateX(-${activeMediaIndex * 100}%)` }}>
                {job.media.map((media) => (
                  <div className="media-tile" key={media.id}>
                    <MediaPreview media={media} />
                    <div className="media-caption">
                      <span>{media.kind === 'video' ? <Video size={13} /> : <ImageIcon size={13} />}{media.filename}</span>
                      <button type="button" title={`打开 ${media.filename}`} aria-label={`打开 ${media.filename}`} onClick={() => onOpenMedia(media.id)}><FolderOpen size={15} /></button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
            {job.media.length > 1 && <div className="media-pagination" role="group" aria-label="选择此推文的媒体文件">
              {(() => {
                const maxDots = 7;
                const firstDot = Math.max(0, Math.min(activeMediaIndex - Math.floor(maxDots / 2), job.media.length - maxDots));
                return job.media.slice(firstDot, firstDot + maxDots).map((media, offset) => {
                  const index = firstDot + offset;
                  return <button key={media.id} type="button" className={index === activeMediaIndex ? 'is-active' : ''} aria-label={`查看第 ${index + 1} 个文件，共 ${job.media.length} 个`} aria-current={index === activeMediaIndex ? 'true' : undefined} onClick={() => setActiveMediaIndex(index)} />;
                });
              })()}
            </div>}
            {job.media.length > 1 && <span className="media-counter" aria-live="polite">{activeMediaIndex + 1} / {job.media.length}</span>}
          </div>
        )}
      </div>

      <footer className="job-footer">
        {!historical && <span>{job.media.length ? `${job.media.length} 个媒体 · ${formatBytes(totalSize || undefined)}` : `第 ${job.attempts || 1} 次尝试`}</span>}
        <div className="job-actions">
          {active && <button className="text-button danger-text" onClick={() => onAction('cancel', job.id)}><X size={15} />取消</button>}
          {(job.status === 'failed' || job.status === 'canceled') && <button className="text-button" onClick={() => onAction('retry', job.id)}><RotateCcw size={14} />重试</button>}
          {complete && job.media.length === 1 && <button type="button" className="text-button" onClick={() => onOpenMedia(job.media[0].id)}><FolderOpen size={15} />打开文件</button>}
        </div>
      </footer>
    </article>
  );
}

export default function App() {
  const [jobs, setJobs] = useState<DownloadJob[]>([]);
  const [historyTotal, setHistoryTotal] = useState(0);
  const [completedToday, setCompletedToday] = useState(0);
  const [historyPage, setHistoryPage] = useState(0);
  const [input, setInput] = useState('');
  const [tab, setTab] = useState<'queue' | 'history' | 'search'>('queue');
  const [historyView, setHistoryView] = useState<'all' | 'authors'>('all');
  const [archiveRevision, setArchiveRevision] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [notice, setNotice] = useState('');
  const [choosingFolder, setChoosingFolder] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [clearConfirmationOpen, setClearConfirmationOpen] = useState(false);
  const [folderReady, setFolderReady] = useState(false);
  const [folderLabel, setFolderLabel] = useState('Download/X Media Archive');
  const [folderDialogOpen, setFolderDialogOpen] = useState(false);
  const [downloadSubfolder, setDownloadSubfolder] = useState('X Media Archive');
  const [serviceHealthy, setServiceHealthy] = useState<boolean | null>(null);
  const [sessionConfigured, setSessionConfigured] = useState(false);
  const [showSessionPanel, setShowSessionPanel] = useState(false);
  const [sessionBusy, setSessionBusy] = useState(false);
  const archiveBackHandler = useRef<(() => boolean) | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const handledSharedLinks = useRef(new Set<string>());
  const historyPageRef = useRef(0);
  const previousHistoryTotal = useRef<number | null>(null);
  const previousTab = useRef(tab);
  const [searchQuery, setSearchQuery] = useState('');
  const urls = useMemo(() => extractUrls(input), [input]);

  const registerArchiveBackHandler = useCallback((handler: (() => boolean) | null) => {
    archiveBackHandler.current = handler;
  }, []);

  const loadJobs = useMemo(() => createJobRefresh(listJobs, HISTORY_PAGE_SIZE, (result, page) => {
    if (xLoginSupported && previousHistoryTotal.current !== null && previousHistoryTotal.current !== result.historyTotal) {
      setArchiveRevision((current) => current + 1);
    }
    previousHistoryTotal.current = result.historyTotal;
    setJobs(result.jobs);
    setHistoryTotal(result.historyTotal);
    setCompletedToday(result.completedToday);
    historyPageRef.current = page;
    setHistoryPage(page);
  }), []);
  const refreshJobs = useCallback(() => loadJobs(historyPageRef.current), [loadJobs]);

  const submitUrls = useCallback(async (requestedUrls: string[]) => {
    if (!requestedUrls.length) return;
    setSubmitting(true);
    try {
      if (!(await getDownloadFolder()).selected) {
        setFolderDialogOpen(true);
        setNotice('请先重新设置下载位置');
        return;
      }
      const result = await createJobs(requestedUrls);
      setInput('');
      setTab('queue');
      const parts = [`新增 ${result.created.length} 条`];
      if (result.duplicates.length) parts.push(`去重 ${result.duplicates.length} 条`);
      if (result.rejected.length) parts.push(`拒绝 ${result.rejected.length} 条无效链接`);
      setNotice(parts.join('，'));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '提交失败');
    } finally {
      setSubmitting(false);
    }
  }, []);

  const receiveSharedContent = useCallback(async (text: string) => {
    const sharedUrls = extractUrls(text);
    const key = sharedUrls.join('\n');
    if (!key || handledSharedLinks.current.has(key)) return;
    handledSharedLinks.current.add(key);
    setInput(sharedUrls.join('\n'));
    setNotice(`已接收 ${sharedUrls.length} 条 X 链接，准备下载`);
    await submitUrls(sharedUrls);
  }, [submitUrls]);

  useEffect(() => {
    void refreshJobs().catch((error) => setNotice(error.message));
    void getDownloadFolder().then((result) => {
      setFolderReady(result.selected);
      if (result.label) {
        setFolderLabel(result.label);
        if (result.mode === 'downloads') setDownloadSubfolder(result.label.replace(/^Download\/?/, ''));
      }
    }).catch(() => undefined);
    if (xLoginSupported) {
      void getXSessionStatus().then((result) => setSessionConfigured(result.configured)).catch(() => undefined);
    }
    const events = subscribeJobs(() => { void refreshJobs().catch((error) => setNotice(error.message)); });
    const shared = subscribeSharedContent((text) => {
      void receiveSharedContent(text);
    });
    void consumeSharedContent().then((result) => {
      if (result.text) void receiveSharedContent(result.text);
    });
    return () => { void events.close(); void shared.close(); };
  }, [receiveSharedContent, refreshJobs]);

  useEffect(() => {
    if (!notice) return;
    const timeout = window.setTimeout(() => setNotice(''), 4200);
    return () => window.clearTimeout(timeout);
  }, [notice]);

  useEffect(() => {
    if (!xLoginSupported) return;
    if (previousTab.current !== tab) window.scrollTo({ top: 0, behavior: 'smooth' });
    previousTab.current = tab;
  }, [tab]);

  useEffect(() => {
    if (!xLoginSupported) return;
    const browserWindow = window as Window & { __cobaltGoBack?: () => boolean };
    const handleBack = () => {
      if (clearConfirmationOpen) {
        setClearConfirmationOpen(false);
        return true;
      }
      if (folderDialogOpen) {
        setFolderDialogOpen(false);
        return true;
      }
      if (showSessionPanel) {
        setShowSessionPanel(false);
        return true;
      }
      if (archiveBackHandler.current?.()) return true;
      if (tab !== 'queue') {
        setTab('queue');
        window.scrollTo({ top: 0, behavior: 'smooth' });
        return true;
      }
      return false;
    };
    browserWindow.__cobaltGoBack = handleBack;
    return () => {
      if (browserWindow.__cobaltGoBack === handleBack) delete browserWindow.__cobaltGoBack;
    };
  }, [clearConfirmationOpen, folderDialogOpen, showSessionPanel, tab]);

  useEffect(() => {
    let disposed = false;
    const refreshHealth = async () => {
      try {
        const health = await getHealth();
        if (!disposed) setServiceHealthy(health.ok && health.local);
      } catch {
        if (!disposed) setServiceHealthy(false);
      }
    };
    void refreshHealth();
    const interval = window.setInterval(() => void refreshHealth(), 30_000);
    return () => {
      disposed = true;
      window.clearInterval(interval);
    };
  }, []);

  const importFile = useCallback(async (file?: File) => {
    if (!file) return;
    if (!/\.(txt|csv)$/i.test(file.name)) {
      setNotice('请选择 TXT 或 CSV 文件');
      return;
    }
    const text = await file.text();
    const imported = extractUrls(text);
    setInput((current) => [...new Set([...extractUrls(current), ...imported])].join('\n'));
    setNotice(`已从 ${file.name} 读取 ${imported.length} 条链接`);
  }, []);

  async function submit() {
    if (!urls.length) return setNotice('请先粘贴至少一条 X 帖子链接');
    await submitUrls(urls);
  }

  async function action(kind: 'cancel' | 'retry', id: string) {
    try {
      await (kind === 'cancel' ? cancelJob(id) : retryJob(id));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '操作失败');
    }
  }

  async function clear() {
    setClearConfirmationOpen(false);
    setClearing(true);
    try {
      const { removed } = await clearHistory();
      historyPageRef.current = 0;
      setHistoryPage(0);
      await refreshJobs();
      setNotice(`已清除 ${removed} 条历史记录`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '无法清除历史记录');
    } finally {
      setClearing(false);
    }
  }

  function requestClearHistory() {
    setClearConfirmationOpen(true);
  }

  async function openJobMedia(id: string) {
    try {
      await openMedia(id);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '无法打开媒体文件');
    }
  }

  async function chooseDownloadFolder() {
    setChoosingFolder(true);
    try {
      const result = await selectDownloadFolder();
      if (result.selected) {
        setFolderReady(true);
        if (result.label) setFolderLabel(result.label);
        setFolderDialogOpen(false);
        setNotice(`下载位置已设置为 ${result.label ?? '所选文件夹'}`);
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '无法选择下载文件夹');
    } finally {
      setChoosingFolder(false);
    }
  }

  const activeJobs = jobs.filter((job) => ['queued', 'resolving', 'downloading'].includes(job.status));
  const historyJobs = jobs.filter((job) => ['completed', 'failed', 'canceled'].includes(job.status));
  const visibleJobs = tab === 'queue' ? activeJobs : historyJobs;

  function openComposer() {
    if (xLoginSupported) {
      setTab('queue');
      requestAnimationFrame(() => {
        document.querySelector<HTMLElement>('.native-ingest-panel')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        textareaRef.current?.focus({ preventScroll: true });
      });
    } else {
      const panel = document.querySelector<HTMLElement>('.ingest-panel');
      panel?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      textareaRef.current?.blur();
    }
    void readClipboardText().then((clipboardText) => {
      const value = clipboardText.trim();
      if (value) setInput((current) => current.trim() ? `${current.trim()}\n${value}` : value);
    }).catch(() => undefined);
  }

  async function connectX() {
    if (!xLoginSupported) {
      setNotice('请在 Android 应用中使用内置 X 登录；auth_token 与 ct0 会通过 Keystore 加密保存');
      return;
    }
    setSessionBusy(true);
    try {
      const result = await startXLogin();
      setSessionConfigured(result.configured);
      if (!result.canceled && result.configured) {
        setShowSessionPanel(false);
        setNotice('X 登录已加密保存；现在可下载当前账号有权查看的受保护帖子');
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '无法打开 X 登录');
    } finally {
      setSessionBusy(false);
    }
  }

  async function disconnectX() {
    setSessionBusy(true);
    try {
      const result = await clearXSession();
      setSessionConfigured(result.configured);
      setShowSessionPanel(false);
      setNotice('已移除本机保存的 X 登录；之后仅下载公开帖子');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '无法移除 X 登录');
    } finally {
      setSessionBusy(false);
    }
  }

  function jumpToTab(nextTab: 'queue' | 'history' | 'search') {
    setTab(nextTab);
    if (xLoginSupported) window.scrollTo({ top: 0, behavior: 'smooth' });
    else document.querySelector('.workspace')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  async function saveDownloadSubfolder() {
    setChoosingFolder(true);
    try {
      const result = await setDownloadPath(downloadSubfolder);
      setFolderReady(result.selected);
      setFolderLabel(result.label ?? 'Download');
      setFolderDialogOpen(false);
      setNotice(`下载位置已设置为 ${result.label ?? 'Download'}`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '无法设置下载位置');
    } finally {
      setChoosingFolder(false);
    }
  }

  function jumpHome() {
    setTab('queue');
    if (xLoginSupported) window.scrollTo({ top: 0, behavior: 'smooth' });
    else document.querySelector('#top')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function showHistoryPage(page: number) {
    const lastPage = Math.max(0, Math.ceil(historyTotal / HISTORY_PAGE_SIZE) - 1);
    const nextPage = Math.min(Math.max(page, 0), lastPage);
    historyPageRef.current = nextPage;
    void refreshJobs().catch((error) => setNotice(error.message));
  }

  const ingestPanel = (
    <section className={`ingest-panel ${xLoginSupported ? 'native-ingest-panel' : ''}`}>
      <div className="panel-heading">
        <div><span><Link2 size={26} /></span><div><h2>添加链接</h2><small>支持单条或批量导入 X 帖子链接</small></div></div>
        <div className="privacy-chip"><ShieldCheck size={13} /> {xLoginSupported && sessionConfigured ? '已启用账号访问' : '默认仅公开内容'}</div>
      </div>
      <div className="composer">
        <textarea
          ref={textareaRef}
          value={input}
          onChange={(event) => setInput(event.target.value)}
          placeholder="粘贴 X 帖子链接"
          aria-label="X 帖子链接"
        />
        <div
          className={`drop-zone ${dragging ? 'dragging' : ''}`}
          onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => { event.preventDefault(); setDragging(false); void importFile(event.dataTransfer.files[0]); }}
          onClick={() => fileRef.current?.click()}
          role="button"
          tabIndex={0}
          onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); fileRef.current?.click(); } }}
        >
          <Upload size={16} /><span>导入 TXT / CSV</span>
          <input ref={fileRef} type="file" accept=".txt,.csv,text/plain,text/csv" hidden onChange={(event) => void importFile(event.target.files?.[0])} />
        </div>
      </div>
      <div className="submit-row">
        <div className={`input-count ${urls.length ? 'has-links' : ''}`}><FileText size={15} /><strong>{urls.length}</strong> 条链接已识别</div>
        <button className="primary-button" onClick={() => void submit()} disabled={!urls.length || submitting}>
          {submitting ? <LoaderCircle className="spin" size={18} /> : <ArrowDownToLine size={18} />}
          开始下载
        </button>
      </div>
    </section>
  );

  const sessionPanel = showSessionPanel && (
    <section className="auth-session-panel" aria-label="X 登录设置">
      <span className="auth-session-icon"><ShieldCheck size={21} /></span>
      <div className="auth-session-copy">
        <strong>{sessionConfigured ? 'X 登录已安全保存' : '下载当前账号可见的受保护帖子'}</strong>
        <small>{xLoginSupported ? '登录在隔离 WebView 中完成；应用只读取 auth_token 和 ct0，用 Android Keystore 加密后立即清除临时 Cookie 与网页存储。' : '此入口会在 Android 应用中打开隔离登录页，并加密保存 auth_token 和 ct0；浏览器预览不保存任何 Cookie。'}</small>
      </div>
      <div className="auth-session-actions">
        {sessionConfigured ? (
          <button className="danger-outline-button" type="button" onClick={() => void disconnectX()} disabled={sessionBusy}>移除登录</button>
        ) : (
          <button className="auth-login-button" type="button" onClick={() => void connectX()} disabled={sessionBusy}>
            {sessionBusy ? <LoaderCircle className="spin" size={16} /> : <ShieldCheck size={16} />}打开 X 登录
          </button>
        )}
        <button className="auth-close-button" type="button" onClick={() => setShowSessionPanel(false)} aria-label="关闭 X 登录设置"><X size={16} /></button>
      </div>
    </section>
  );

  const quickStats = (
    <section className="quick-stats" aria-label="下载统计">
      <div className="active-stat"><span className="stat-icon"><ArrowDownToLine size={29} /></span><div><span>正在下载</span><strong>{String(activeJobs.length).padStart(2, '0')}</strong></div></div>
      <div className="complete-stat"><span className="stat-icon"><Check size={31} /></span><div><span>今日完成</span><strong>{String(completedToday).padStart(2, '0')}</strong></div></div>
    </section>
  );

  return (
    <div className={`app-shell ${xLoginSupported ? 'is-native' : ''}`}>
      <header className="topbar">
        <div className="topbar-actions">
          <button
            className={`folder-button ${folderReady ? 'is-ready' : ''}`}
            type="button"
            title={`下载位置：${folderLabel}，点击更改`}
            onClick={() => xLoginSupported ? setFolderDialogOpen(true) : void chooseDownloadFolder()}
            disabled={choosingFolder}
          >
            {choosingFolder ? <LoaderCircle className="spin" size={17} /> : folderReady ? <FolderCheck size={17} /> : <FolderOpen size={17} />}
            <span>{xLoginSupported ? '下载位置' : folderReady ? '文件夹已设置' : '选择下载文件夹'}</span>
          </button>
          <button
            className={`session-button ${sessionConfigured ? 'is-ready' : ''}`}
            type="button"
            title={sessionConfigured ? '管理已保存的 X 登录' : '登录 X 并加密保存 auth_token、ct0'}
            aria-label={sessionConfigured ? '管理已保存的 X 登录' : '登录 X 并加密保存 auth_token、ct0'}
            onClick={() => setShowSessionPanel((visible) => !visible)}
            disabled={sessionBusy}
          >
            {sessionBusy ? <LoaderCircle className="spin" size={17} /> : <ShieldCheck size={17} />}
            <span>{sessionConfigured ? 'X 已登录' : '登录 X'}</span>
          </button>
          <div className={`service-state ${serviceHealthy === false ? 'is-offline' : ''}`}><span /> {serviceHealthy === null ? '正在检查本地服务' : serviceHealthy ? '本地服务可用' : '本地服务不可用'}</div>
        </div>
      </header>

      <main id="top" className={xLoginSupported ? 'native-main' : ''}>
        {xLoginSupported ? (
          <>
            {sessionPanel}
            <div className="native-pages">
              <section className={`native-page ${tab === 'queue' ? 'is-current' : ''}`} aria-label="首页">
                {ingestPanel}
                {quickStats}
                <section className="workspace">
                  <div className="workspace-head"><div className="workspace-title"><h2>进行中的任务</h2></div></div>
                  {activeJobs.length ? (
                    <div className="job-list">{activeJobs.map((job) => <JobCard key={job.id} job={job} onAction={action} onOpenMedia={(id) => void openJobMedia(id)} />)}</div>
                  ) : (
                    <div className="empty-state">
                      <span><Pause size={25} /></span>
                      <h3>准备好开始下载</h3>
                      <p>添加链接后，下载进度会实时出现在这里。</p>
                      <button onClick={openComposer}><Link2 size={15} />添加第一个链接</button>
                    </div>
                  )}
                </section>
              </section>

              <section className={`native-page native-search-page ${tab === 'search' ? 'is-current' : ''}`} aria-label="搜索">
                <HistoryBrowser
                  mode="search"
                  active={tab === 'search'}
                  revision={archiveRevision}
                  searchQuery={searchQuery}
                  onSearchQueryChange={setSearchQuery}
                  onDetailBackChange={registerArchiveBackHandler}
                  renderJob={(job) => <JobCard job={job} onAction={action} onOpenMedia={(id) => void openJobMedia(id)} presentation="history" />}
                  onError={setNotice}
                />
              </section>

              <section className={`native-page ${tab === 'history' ? 'is-current' : ''}`} aria-label="历史">
                <section className="workspace native-history-workspace">
                  <div className="workspace-head">
                    <div className="workspace-title"><span>本地归档</span><h2>历史记录</h2></div>
                    {historyTotal > 0 && <button className="clear-button" type="button" onClick={requestClearHistory} disabled={clearing}>{clearing ? <LoaderCircle className="spin" size={15} /> : <Trash2 size={15} />}{clearing ? '正在清除' : '清除'}</button>}
                  </div>
                  <div className="archive-view-tabs" role="tablist" aria-label="历史浏览方式">
                    <button type="button" role="tab" aria-selected={historyView === 'all'} className={historyView === 'all' ? 'selected' : ''} onClick={() => setHistoryView('all')}>全部推文</button>
                    <button type="button" role="tab" aria-selected={historyView === 'authors'} className={historyView === 'authors' ? 'selected' : ''} onClick={() => setHistoryView('authors')}>作者</button>
                  </div>
                  {historyView === 'authors' ? <HistoryBrowser
                    mode="authors"
                    revision={archiveRevision}
                    onDetailBackChange={registerArchiveBackHandler}
                    renderJob={(job) => <JobCard job={job} onAction={action} onOpenMedia={(id) => void openJobMedia(id)} presentation="history" />}
                    onError={setNotice}
                  /> : historyJobs.length ? (
                    <>
                      <div className="job-list history-post-list">{historyJobs.map((job) => <JobCard key={job.id} job={job} onAction={action} onOpenMedia={(id) => void openJobMedia(id)} presentation="history" />)}</div>
                      {historyTotal > HISTORY_PAGE_SIZE && <nav className="history-pagination" aria-label="下载历史分页">
                        <button onClick={() => showHistoryPage(historyPage - 1)} disabled={historyPage === 0}>上一页</button>
                        <span>第 {historyPage + 1} / {Math.ceil(historyTotal / HISTORY_PAGE_SIZE)} 页</span>
                        <button onClick={() => showHistoryPage(historyPage + 1)} disabled={(historyPage + 1) * HISTORY_PAGE_SIZE >= historyTotal}>下一页</button>
                      </nav>}
                    </>
                  ) : <div className="empty-state"><span><History size={25} /></span><h3>这里还很安静</h3><p>完成、失败或取消的任务都会保留在这里。</p></div>}
                </section>
              </section>
            </div>
          </>
        ) : (
          <>
            {ingestPanel}
            {sessionPanel}
            {quickStats}
            <section className="workspace">
              <div className="workspace-head">
                <div className="workspace-title"><span>下载管理</span><h2>{tab === 'queue' ? '正在下载' : tab === 'search' ? '搜索' : '历史记录'}</h2></div>
                {tab === 'history' && historyTotal > 0 && <button className="clear-button" type="button" onClick={requestClearHistory} disabled={clearing}>{clearing ? <LoaderCircle className="spin" size={15} /> : <Trash2 size={15} />}{clearing ? '正在清除' : '清除'}</button>}
              </div>
              {tab !== 'search' && <div className="tabs" role="tablist" aria-label="下载任务筛选">
                <button role="tab" aria-selected={tab === 'queue'} className={tab === 'queue' ? 'selected' : ''} onClick={() => setTab('queue')}><Archive size={17} />进行中 <span>{activeJobs.length}</span></button>
                <button role="tab" aria-selected={tab === 'history'} className={tab === 'history' ? 'selected' : ''} onClick={() => setTab('history')}><History size={17} />历史 <span>{historyTotal}</span></button>
              </div>}
              {visibleJobs.length ? (
                <>
                  <div className={`job-list ${tab === 'history' ? 'history-post-list' : ''}`}>{visibleJobs.map((job) => <JobCard key={job.id} job={job} onAction={action} onOpenMedia={(id) => void openJobMedia(id)} presentation={tab === 'history' ? 'history' : 'queue'} />)}</div>
                  {tab === 'history' && historyTotal > HISTORY_PAGE_SIZE && <nav className="history-pagination" aria-label="下载历史分页">
                    <button onClick={() => showHistoryPage(historyPage - 1)} disabled={historyPage === 0}>上一页</button>
                    <span>第 {historyPage + 1} / {Math.ceil(historyTotal / HISTORY_PAGE_SIZE)} 页</span>
                    <button onClick={() => showHistoryPage(historyPage + 1)} disabled={(historyPage + 1) * HISTORY_PAGE_SIZE >= historyTotal}>下一页</button>
                  </nav>}
                </>
              ) : <div className="empty-state">
                <span>{tab === 'queue' ? <Pause size={25} /> : <History size={25} />}</span>
                <h3>{tab === 'queue' ? '准备好开始下载' : '这里还很安静'}</h3>
                <p>{tab === 'queue' ? '添加链接后，下载进度会实时出现在这里。' : '完成、失败或取消的任务都会保留在这里。'}</p>
                {tab === 'queue' && <button onClick={openComposer}><Link2 size={15} />添加第一个链接</button>}
              </div>}
            </section>
            <section className="privacy-note">
              <span><ShieldCheck size={19} /></span>
              <div><strong>{sessionConfigured ? '已启用受保护帖子下载' : '隐私优先'}</strong><small>{sessionConfigured ? '只使用 Keystore 加密的 X 会话，并仅发送给 X' : '无需登录时，不保存或发送任何 X Cookie'}</small></div>
              <Check size={17} />
            </section>
          </>
        )}
      </main>

      <footer className="page-footer"><span>媒体由本地服务解析与保存</span><span>{xLoginSupported && sessionConfigured ? 'X 会话经 Android Keystore 加密' : '公开帖子无需登录'}</span></footer>
      <nav className={`mobile-nav ${xLoginSupported ? 'has-search' : ''}`} aria-label="主导航">
        <button className={tab === 'queue' ? 'selected' : ''} onClick={jumpHome} aria-current={tab === 'queue' ? 'page' : undefined}>
          <Home size={21} /><span>首页</span>
        </button>
        <button className="mobile-add" onClick={openComposer} aria-label={xLoginSupported ? '新建下载链接' : '添加下载链接'}>
          <span><Link2 size={21} /></span><small>新建</small>
        </button>
        {xLoginSupported && <button className={tab === 'search' ? 'selected' : ''} onClick={() => jumpToTab('search')} aria-current={tab === 'search' ? 'page' : undefined}>
          <Search size={20} /><span>搜索</span>
        </button>}
        <button className={tab === 'history' ? 'selected' : ''} onClick={() => jumpToTab('history')} aria-current={tab === 'history' ? 'page' : undefined}>
          <History size={20} /><span>历史</span>{historyTotal > 0 && <b>{historyTotal}</b>}
        </button>
      </nav>
      {folderDialogOpen && <div className="confirmation-backdrop">
        <section className="confirmation-dialog folder-dialog" role="dialog" aria-modal="true" aria-labelledby="download-folder-title">
          <h2 id="download-folder-title">选择下载位置</h2>
          <p>当前位置：{folderLabel}</p>
          <label htmlFor="download-subfolder">保存到 Download 下的文件夹</label>
          <div className="folder-path-input"><span>Download /</span><input id="download-subfolder" value={downloadSubfolder} onChange={(event) => setDownloadSubfolder(event.target.value)} placeholder="留空即保存到 Download" autoFocus /></div>
          <p>可填写多级路径，例如 X Media Archive/收藏。系统不允许通过文件夹选择器直接授权 Download 根目录，这里可直接设置。</p>
          <button type="button" className="folder-save" onClick={() => void saveDownloadSubfolder()} disabled={choosingFolder}>保存此位置</button>
          <button type="button" className="folder-pick" onClick={() => void chooseDownloadFolder()} disabled={choosingFolder}>选择其他文件夹…</button>
          <div className="confirmation-actions"><button type="button" className="confirmation-cancel" onClick={() => setFolderDialogOpen(false)} disabled={choosingFolder}>取消</button></div>
        </section>
      </div>}
      {clearConfirmationOpen && <div className="confirmation-backdrop">
        <section className="confirmation-dialog" role="alertdialog" aria-modal="true" aria-labelledby="clear-history-title" aria-describedby="clear-history-description">
          <h2 id="clear-history-title">清除下载历史？</h2>
          <p id="clear-history-description">此操作会移除完成、失败和取消任务的历史记录，但不会删除已保存的媒体文件。</p>
          <div className="confirmation-actions">
            <button type="button" className="confirmation-cancel" autoFocus onClick={() => setClearConfirmationOpen(false)}>取消</button>
            <button type="button" className="confirmation-danger" onClick={() => void clear()} disabled={clearing}>{clearing ? '正在清除' : '清除历史'}</button>
          </div>
        </section>
      </div>}
      {notice && <div className="toast" role="status"><CircleAlert size={17} />{notice}<button onClick={() => setNotice('')} aria-label="关闭提示"><X size={15} /></button></div>}
    </div>
  );
}
