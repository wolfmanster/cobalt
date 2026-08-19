import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Archive,
  ArrowDownToLine,
  Check,
  CircleAlert,
  Clock3,
  Download,
  FileText,
  FolderOpen,
  History,
  Image as ImageIcon,
  LoaderCircle,
  Pause,
  Play,
  RotateCcw,
  Trash2,
  Upload,
  Video,
  X,
  Zap,
} from 'lucide-react';
import { cancelJob, clearHistory, createJobs, getDownloadFolder, listJobs, openMedia, retryJob, selectDownloadFolder, subscribeJobs } from './api';
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

function MediaPreview({ media }: { media: MediaItem }) {
  if (media.kind === 'image' || media.kind === 'gif') {
    return <img src={media.previewUrl} alt={media.filename} loading="lazy" />;
  }
  return <video src={media.previewUrl} controls preload="metadata" />;
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
              <span>{job.status === 'queued' ? '等待空闲下载槽位' : job.status === 'resolving' ? '正在并行获取元数据与媒体' : `正在保存 ${job.media.length} 个媒体文件`}</span>
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
  const fileRef = useRef<HTMLInputElement>(null);
  const urls = useMemo(() => extractUrls(input), [input]);

  useEffect(() => {
    void listJobs().then(setJobs).catch((error) => setNotice(error.message));
    const events = subscribeJobs(setJobs);
    return () => { void events.close(); };
  }, []);

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
    setSubmitting(true);
    try {
      if (!(await getDownloadFolder()).selected) {
        const selected = await selectDownloadFolder();
        if (!selected.selected) {
          setNotice('请选择下载文件夹后再加入队列');
          return;
        }
      }
      const result = await createJobs(urls);
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
      if (result.selected) setNotice('已保存下载文件夹；新任务将写入该文件夹');
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

  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="#top"><span className="brand-mark">▶</span><span>Veo Downloader<small>VIDEO DOWNLOADER</small></span></a>
        <div className="topbar-actions">
          <button
            className="folder-button"
            type="button"
            title="选择或更改下载文件夹"
            onClick={() => void chooseDownloadFolder()}
            disabled={choosingFolder}
          >
            {choosingFolder ? <LoaderCircle className="spin" size={15} /> : <FolderOpen size={15} />}
            选择下载文件夹
          </button>
          <div className="service-state"><span /> Cobalt 本地解析</div>
        </div>
      </header>

      <main id="top">
        <section className="hero">
          <div className="eyebrow"><Zap size={13} fill="currentColor" /> PUBLIC POSTS ONLY</div>
          <h1>把公开帖子，<br /><em>妥善存下来。</em></h1>
          <p>批量提取 X 帖子中的视频、图片与 GIF，同时保留必要的作者和正文信息。</p>
        </section>

        <section className="ingest-panel">
          <div className="panel-heading">
            <div><span>01</span><h2>添加帖子链接</h2></div>
            <p>支持单条、多行粘贴，最多 200 条</p>
          </div>
          <textarea
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder={'https://x.com/user/status/123456789\nhttps://x.com/user/status/987654321'}
            aria-label="X 帖子链接"
          />
          <div
            className={`drop-zone ${dragging ? 'dragging' : ''}`}
            onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={(event) => { event.preventDefault(); setDragging(false); void importFile(event.dataTransfer.files[0]); }}
            onClick={() => fileRef.current?.click()}
          >
            <Upload size={17} /><span>拖入 TXT / CSV，或点击选择</span>
            <input ref={fileRef} type="file" accept=".txt,.csv,text/plain,text/csv" hidden onChange={(event) => void importFile(event.target.files?.[0])} />
          </div>
          <div className="submit-row">
            <div className="input-count"><FileText size={15} /><strong>{urls.length}</strong> 条可识别链接</div>
            <button className="primary-button" onClick={() => void submit()} disabled={!urls.length || submitting}>
              {submitting ? <LoaderCircle className="spin" size={17} /> : <Play size={17} fill="currentColor" />}
              加入下载队列
            </button>
          </div>
        </section>

        <section className="workspace">
          <div className="workspace-head">
            <div className="tabs">
              <button className={tab === 'queue' ? 'selected' : ''} onClick={() => setTab('queue')}><Archive size={17} />下载队列 <span>{activeJobs.length}</span></button>
              <button className={tab === 'history' ? 'selected' : ''} onClick={() => setTab('history')}><History size={17} />历史记录 <span>{historyJobs.length}</span></button>
            </div>
            {tab === 'history' && historyJobs.length > 0 && <button className="clear-button" onClick={() => void clear()}><Trash2 size={14} />清除记录</button>}
          </div>

          {visibleJobs.length ? (
            <div className="job-list">{visibleJobs.map((job) => <JobCard key={job.id} job={job} onAction={action} />)}</div>
          ) : (
            <div className="empty-state">
              {tab === 'queue' ? <Pause size={28} /> : <History size={28} />}
              <h3>{tab === 'queue' ? '队列目前是空的' : '还没有历史记录'}</h3>
              <p>{tab === 'queue' ? '粘贴公开帖子链接，任务会在这里实时更新。' : '完成、失败或取消的任务会保留在这里。'}</p>
            </div>
          )}
        </section>

        <section className="stats-strip">
          <div><span>今日完成</span><strong>{String(completedToday).padStart(2, '0')}</strong></div>
          <div><span>队列进行中</span><strong>{String(activeJobs.length).padStart(2, '0')}</strong></div>
          <div><span>存档总数</span><strong>{String(jobs.filter((job) => job.status === 'completed').length).padStart(2, '0')}</strong></div>
          <div className="privacy-note"><Check size={15} /><span>无需 Cookie<br /><small>仅处理公开帖子</small></span></div>
        </section>
      </main>

      <footer className="page-footer"><span>媒体由本地 Cobalt 实例解析</span><span>不使用 X 官方 API · 不保存 Cookie</span></footer>
      {notice && <div className="toast"><CircleAlert size={16} />{notice}<button onClick={() => setNotice('')}><X size={14} /></button></div>}
    </div>
  );
}
