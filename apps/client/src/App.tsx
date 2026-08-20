import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import {
  Archive,
  ArrowDownToLine,
  Check,
  CircleAlert,
  Clock3,
  Download,
  Facebook,
  FileText,
  FolderCheck,
  FolderOpen,
  History,
  Image as ImageIcon,
  Instagram,
  Link2,
  LoaderCircle,
  Music2,
  Pause,
  RotateCcw,
  ShieldCheck,
  Trash2,
  Twitch,
  Upload,
  Video,
  X,
  Youtube,
} from 'lucide-react';
import { cancelJob, clearHistory, clearXSession, consumeSharedContent, createJobs, getDownloadFolder, getXSessionStatus, listJobs, openMedia, readClipboardText, retryJob, selectDownloadFolder, startXLogin, subscribeJobs, subscribeSharedContent, xLoginSupported } from './api';
import type { DownloadJob, JobStatus, MediaItem } from './types';

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

function JobCard({ job, onAction }: { job: DownloadJob; onAction: (action: 'cancel' | 'retry', id: string) => void }) {
  const active = ['queued', 'resolving', 'downloading'].includes(job.status);
  const complete = job.status === 'completed';
  const totalSize = job.media.reduce((sum, item) => sum + (item.size ?? 0), 0);

  return (
    <article className={`job-card ${active ? 'is-active' : ''}`}>
      <div className="job-main">
        <div className="author-row">
          <div className="avatar-wrap">
            {job.metadata?.avatarUrl ? (
              <img className="avatar" src={job.metadata.avatarUrl} alt="" />
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
              <span>ID {job.tweetId}</span>
              {job.metadata?.language && <span>{job.metadata.language.toUpperCase()}</span>}
              <span>{formatDate(job.metadata?.publishedAt ?? job.createdAt)}</span>
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
          <div className={`media-grid count-${Math.min(job.media.length, 4)}`}>
            {job.media.map((media) => (
              <div className="media-tile" key={media.id}>
                <MediaPreview media={media} />
                <div className="media-caption">
                  <span>{media.kind === 'video' ? <Video size={13} /> : <ImageIcon size={13} />}{media.filename}</span>
                  <a
                    href={media.downloadUrl}
                    title="下载"
                    onClick={(event) => {
                      if (media.downloadUrl.startsWith('content:')) {
                        event.preventDefault();
                        void openMedia(media.id);
                      }
                    }}
                  ><Download size={15} /></a>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <footer className="job-footer">
        <span>{job.media.length ? `${job.media.length} 个媒体 · ${formatBytes(totalSize || undefined)}` : `第 ${job.attempts || 1} 次尝试`}</span>
        <div className="job-actions">
          {active && <button className="text-button danger-text" onClick={() => onAction('cancel', job.id)}><X size={15} />取消</button>}
          {(job.status === 'failed' || job.status === 'canceled') && <button className="text-button" onClick={() => onAction('retry', job.id)}><RotateCcw size={14} />重试</button>}
          {complete && <a
            className="text-button"
            href={job.media[0]?.downloadUrl}
            onClick={(event) => {
              const firstMedia = job.media[0];
              if (firstMedia?.downloadUrl.startsWith('content:')) {
                event.preventDefault();
                void openMedia(firstMedia.id);
              }
            }}
          ><ArrowDownToLine size={15} />{job.media.length > 1 ? '逐个下载' : '下载文件'}</a>}
        </div>
      </footer>
    </article>
  );
}

export default function App() {
  const [jobs, setJobs] = useState<DownloadJob[]>([]);
  const [input, setInput] = useState('');
  const [tab, setTab] = useState<'queue' | 'history'>('queue');
  const [submitting, setSubmitting] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [notice, setNotice] = useState('');
  const [choosingFolder, setChoosingFolder] = useState(false);
  const [folderReady, setFolderReady] = useState(false);
  const [sessionConfigured, setSessionConfigured] = useState(false);
  const [showSessionPanel, setShowSessionPanel] = useState(false);
  const [sessionBusy, setSessionBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const handledSharedLinks = useRef(new Set<string>());
  const urls = useMemo(() => extractUrls(input), [input]);

  const submitUrls = useCallback(async (requestedUrls: string[]) => {
    if (!requestedUrls.length) return;
    setSubmitting(true);
    try {
      if (!(await getDownloadFolder()).selected) {
        const selected = await selectDownloadFolder();
        if (!selected.selected) {
          setNotice('请选择下载文件夹后再加入队列');
          return;
        }
        setFolderReady(true);
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
    void listJobs().then(setJobs).catch((error) => setNotice(error.message));
    void getDownloadFolder().then((result) => setFolderReady(result.selected)).catch(() => undefined);
    if (xLoginSupported) {
      void getXSessionStatus().then((result) => setSessionConfigured(result.configured)).catch(() => undefined);
    }
    const events = subscribeJobs(setJobs);
    const shared = subscribeSharedContent((text) => {
      void receiveSharedContent(text);
    });
    void consumeSharedContent().then((result) => {
      if (result.text) void receiveSharedContent(result.text);
    });
    return () => { void events.close(); void shared.close(); };
  }, [receiveSharedContent]);

  useEffect(() => {
    if (!notice) return;
    const timeout = window.setTimeout(() => setNotice(''), 4200);
    return () => window.clearTimeout(timeout);
  }, [notice]);

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
    const { removed } = await clearHistory();
    setNotice(`已清除 ${removed} 条历史记录`);
  }

  async function chooseDownloadFolder() {
    setChoosingFolder(true);
    try {
      const result = await selectDownloadFolder();
      if (result.selected) {
        setFolderReady(true);
        setNotice('已保存下载文件夹；新任务将写入该文件夹');
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
  const completedToday = jobs.filter((job) => job.completedAt?.slice(0, 10) === new Date().toISOString().slice(0, 10)).length;
  const completedTotal = jobs.filter((job) => job.status === 'completed').length;

  function openComposer() {
    const panel = document.querySelector<HTMLElement>('.ingest-panel');
    const textarea = panel?.querySelector<HTMLTextAreaElement>('textarea');
    panel?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    textarea?.blur();
    void readClipboardText().then((clipboardText) => {
      const value = clipboardText.trim();
      if (value) setInput((current) => current.trim() ? `${current.trim()}\n${value}` : value);
    }).catch(() => undefined);
  }

  async function connectX() {
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

  function jumpToTab(nextTab: 'queue' | 'history') {
    setTab(nextTab);
    document.querySelector('.workspace')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="topbar-actions">
          <button
            className={`folder-button ${folderReady ? 'is-ready' : ''}`}
            type="button"
            title="选择或更改下载文件夹"
            onClick={() => void chooseDownloadFolder()}
            disabled={choosingFolder}
          >
            {choosingFolder ? <LoaderCircle className="spin" size={17} /> : folderReady ? <FolderCheck size={17} /> : <FolderOpen size={17} />}
            <span>{folderReady ? '文件夹已设置' : '选择下载文件夹'}</span>
          </button>
          {xLoginSupported && (
            <button
              className={`session-button ${sessionConfigured ? 'is-ready' : ''}`}
              type="button"
              title={sessionConfigured ? '管理 X 登录' : '登录 X 以访问未公开帖子'}
              onClick={() => setShowSessionPanel((visible) => !visible)}
              disabled={sessionBusy}
            >
              {sessionBusy ? <LoaderCircle className="spin" size={17} /> : <ShieldCheck size={17} />}
              <span>{sessionConfigured ? 'X 已登录' : '登录 X'}</span>
            </button>
          )}
          <div className="service-state"><span /> 本地服务在线</div>
        </div>
      </header>

      <main id="top">
        <section className="hero" aria-label="多平台媒体下载">
          <div className="platform-scene" aria-hidden="true">
            <div className="platform-orbit orbit-one" />
            <div className="platform-orbit orbit-two" />
            <div className="platform-core"><ArrowDownToLine size={34} /></div>
            <div className="platform-chip platform-instagram"><Instagram size={22} /><span>Instagram</span></div>
            <div className="platform-chip platform-youtube"><Youtube size={23} /><span>YouTube</span></div>
            <div className="platform-chip platform-x"><b>𝕏</b></div>
            <div className="platform-chip platform-tiktok"><Music2 size={21} /><span>TikTok</span></div>
            <div className="platform-chip platform-facebook"><Facebook size={21} /><span>Facebook</span></div>
            <div className="platform-chip platform-twitch"><Twitch size={21} /><span>Twitch</span></div>
          </div>
        </section>

        <section className="ingest-panel">
          <div className="panel-heading">
            <div><span><Link2 size={17} /></span><div><h2>添加帖子链接</h2><small>每行一个，最多 200 条</small></div></div>
            <div className="privacy-chip"><ShieldCheck size={13} /> {xLoginSupported && sessionConfigured ? '已启用账号访问' : '默认仅公开内容'}</div>
          </div>
          <div className="composer">
            <textarea
              value={input}
              onChange={(event) => setInput(event.target.value)}
              placeholder={'在这里粘贴 X 帖子链接…\nhttps://x.com/user/status/123456789'}
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
              onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') fileRef.current?.click(); }}
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

        {xLoginSupported && showSessionPanel && (
          <section className="auth-session-panel" aria-label="X 登录设置">
            <span className="auth-session-icon"><ShieldCheck size={21} /></span>
            <div className="auth-session-copy">
              <strong>{sessionConfigured ? 'X 登录已安全保存' : '下载当前账号可见的受保护帖子'}</strong>
              <small>登录在隔离 WebView 中完成；应用只读取 auth_token 和 ct0，用 Android Keystore 加密后立即清除临时 Cookie 与网页存储。</small>
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
        )}

        <section className="quick-stats" aria-label="下载统计">
          <div><span>今日完成</span><strong>{String(completedToday).padStart(2, '0')}</strong><i className="violet" /></div>
          <div><span>正在处理</span><strong>{String(activeJobs.length).padStart(2, '0')}</strong><i className="orange" /></div>
          <div><span>全部存档</span><strong>{String(completedTotal).padStart(2, '0')}</strong><i className="green" /></div>
        </section>

        <section className="workspace">
          <div className="workspace-head">
            <div className="workspace-title"><span>下载管理</span><h2>{tab === 'queue' ? '当前任务' : '历史记录'}</h2></div>
            {tab === 'history' && historyJobs.length > 0 && <button className="clear-button" onClick={() => void clear()}><Trash2 size={15} />清除</button>}
          </div>
          <div className="tabs" role="tablist" aria-label="下载任务筛选">
              <button role="tab" aria-selected={tab === 'queue'} className={tab === 'queue' ? 'selected' : ''} onClick={() => setTab('queue')}><Archive size={17} />进行中 <span>{activeJobs.length}</span></button>
              <button role="tab" aria-selected={tab === 'history'} className={tab === 'history' ? 'selected' : ''} onClick={() => setTab('history')}><History size={17} />已完成 <span>{historyJobs.length}</span></button>
            </div>

          {visibleJobs.length ? (
            <div className="job-list">{visibleJobs.map((job) => <JobCard key={job.id} job={job} onAction={action} />)}</div>
          ) : (
            <div className="empty-state">
              <span>{tab === 'queue' ? <Pause size={25} /> : <History size={25} />}</span>
              <h3>{tab === 'queue' ? '准备好开始下载' : '这里还很安静'}</h3>
              <p>{tab === 'queue' ? '添加链接后，下载进度会实时出现在这里。' : '完成、失败或取消的任务都会保留在这里。'}</p>
              {tab === 'queue' && <button onClick={openComposer}><Link2 size={15} />添加第一个链接</button>}
            </div>
          )}
        </section>

        <section className="privacy-note">
          <span><ShieldCheck size={19} /></span>
          <div><strong>{sessionConfigured ? '已启用受保护帖子下载' : '隐私优先'}</strong><small>{sessionConfigured ? '只使用 Keystore 加密的 X 会话，并仅发送给 X' : '无需登录时，不保存或发送任何 X Cookie'}</small></div>
          <Check size={17} />
        </section>
      </main>

      <footer className="page-footer"><span>媒体由本地服务解析与保存</span><span>{xLoginSupported && sessionConfigured ? 'X 会话经 Android Keystore 加密' : '公开帖子无需登录'}</span></footer>
      <nav className="mobile-nav" aria-label="主导航">
        <button className={tab === 'queue' ? 'selected' : ''} onClick={() => jumpToTab('queue')} aria-current={tab === 'queue' ? 'page' : undefined}>
          <Archive size={20} /><span>进行中</span>{activeJobs.length > 0 && <b>{activeJobs.length}</b>}
        </button>
        <button className="mobile-add" onClick={openComposer} aria-label="添加下载链接">
          <span><Link2 size={21} /></span><small>新建</small>
        </button>
        <button className={tab === 'history' ? 'selected' : ''} onClick={() => jumpToTab('history')} aria-current={tab === 'history' ? 'page' : undefined}>
          <History size={20} /><span>已完成</span>{historyJobs.length > 0 && <b>{historyJobs.length}</b>}
        </button>
      </nav>
      {notice && <div className="toast" role="status"><CircleAlert size={17} />{notice}<button onClick={() => setNotice('')} aria-label="关闭提示"><X size={15} /></button></div>}
    </div>
  );
}
