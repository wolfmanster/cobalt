import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Check, CircleAlert, Clock3, FolderOpen, Image as ImageIcon, LoaderCircle, Play, RotateCcw, Tags, Video, X } from 'lucide-react';
import { isNativeAndroid, mobileShell } from '../platform';
import type { DownloadJob, JobStatus, MediaItem } from '../types';
import { formatBytes, formatDate } from '../lib/format';
import { MediaPagination, MediaPreview } from './Media';

const STATUS: Record<JobStatus, { label: string; className: string }> = {
  queued: { label: '等待中', className: 'neutral' },
  resolving: { label: '解析帖子', className: 'active' },
  downloading: { label: '下载中', className: 'active' },
  completed: { label: '已完成', className: 'success' },
  failed: { label: '失败', className: 'danger' },
  canceled: { label: '已取消', className: 'neutral' },
};

function statusIcon(status: JobStatus) {
  if (status === 'completed') return <Check size={13} />;
  if (status === 'failed') return <CircleAlert size={13} />;
  if (status === 'downloading' || status === 'resolving') return <LoaderCircle className="spin" size={13} />;
  return <Clock3 size={13} />;
}

function sharePayload(media: MediaItem) {
  return { url: new URL(media.downloadUrl, window.location.href).href, title: media.filename };
}

function shareOffered(media: MediaItem) {
  if (!media.downloadUrl || typeof navigator.share !== 'function') return false;
  if (typeof navigator.canShare !== 'function') return true;
  try {
    return navigator.canShare(sharePayload(media));
  } catch {
    return false;
  }
}

function SaveLink({ media, className, children }: { media: MediaItem; className?: string; children: ReactNode }) {
  return <a className={className} href={media.downloadUrl} download={media.filename} rel="noopener">{children}</a>;
}

function ShareButton({ media, onNotice }: { media: MediaItem; onNotice?: (message: string) => void }) {
  if (!shareOffered(media)) return null;
  return <button type="button" className="text-button" onClick={() => {
    const payload = sharePayload(media);
    if (typeof navigator.canShare === 'function') {
      try {
        if (!navigator.canShare(payload)) return;
      } catch {
        return;
      }
    }
    const share = navigator.share?.bind(navigator);
    if (!share) return;
    void share(payload).catch((error: unknown) => {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      onNotice?.('分享失败，请改用保存');
    });
  }}>分享</button>;
}

export function JobCard({ job, onAction, onOpenMedia, onPreviewMedia, presentation = 'queue', onClassify, selectionMode = false, selected = false, onToggleSelection, onNotice }: { job: DownloadJob; onAction: (action: 'cancel' | 'retry', id: string) => void; onOpenMedia: (media: MediaItem) => void; onPreviewMedia: (media: MediaItem[], index: number) => void; presentation?: 'queue' | 'history'; onClassify?: (tweetId: string) => void; selectionMode?: boolean; selected?: boolean; onToggleSelection?: (tweetId: string) => void; onNotice?: (message: string) => void }) {
  const [avatarFailed, setAvatarFailed] = useState(false);
  const [activeMediaIndex, setActiveMediaIndex] = useState(0);
  const [mediaAspectRatios, setMediaAspectRatios] = useState<Record<string, number>>({});
  const touchStartX = useRef<number | null>(null);
  const mediaViewportRef = useRef<HTMLDivElement | null>(null);
  const mediaTileRefs = useRef<(HTMLDivElement | null)[]>([]);
  const pendingMediaIndex = useRef<number | null>(null);
  const mediaScrollTimer = useRef<number | null>(null);
  useEffect(() => setAvatarFailed(false), [job.metadata?.avatarUrl]);
  useEffect(() => {
    setActiveMediaIndex(0);
    clearPendingMediaSelection();
    return clearPendingMediaSelection;
  }, [job.id, job.media.map((media) => media.id).join('|')]);
  useEffect(() => {
    // Loading a distant image changes the widths before the requested tile.
    // Keep the selected tile aligned while its natural dimensions arrive.
    if (pendingMediaIndex.current !== null) showMedia(pendingMediaIndex.current);
  }, [mediaAspectRatios]);
  const active = ['queued', 'resolving', 'downloading'].includes(job.status);
  const complete = job.status === 'completed';
  const historical = presentation === 'history';
  const canRecoverMedia = Boolean(job.archived && (job.unavailableMedia || !job.media.length));
  const totalSize = job.media.reduce((sum, item) => sum + (item.size ?? 0), 0);
  const activeMediaId = job.media[activeMediaIndex]?.id;
  const activeMediaAspectRatio = activeMediaId ? mediaAspectRatios[activeMediaId] : undefined;
  const activeMedia = job.media[activeMediaIndex];
  const mediaInset = historical ? 52 : 56;

  function clearPendingMediaSelection() {
    pendingMediaIndex.current = null;
    if (mediaScrollTimer.current !== null) window.clearTimeout(mediaScrollTimer.current);
    mediaScrollTimer.current = null;
  }

  function releaseMediaSelectionAfterScroll() {
    if (mediaScrollTimer.current !== null) window.clearTimeout(mediaScrollTimer.current);
    mediaScrollTimer.current = window.setTimeout(() => {
      clearPendingMediaSelection();
      updateActiveMedia();
    }, 180);
  }

  function showMedia(index: number) {
    setActiveMediaIndex(index);
    if (!isNativeAndroid) return;
    const viewport = mediaViewportRef.current;
    const tile = mediaTileRefs.current[index];
    if (!viewport || !tile) return;
    pendingMediaIndex.current = index;
    releaseMediaSelectionAfterScroll();
    const left = viewport.scrollLeft + tile.getBoundingClientRect().left - viewport.getBoundingClientRect().left - mediaInset;
    viewport.scrollTo({ left, behavior: 'smooth' });
  }

  function updateActiveMedia() {
    const viewport = mediaViewportRef.current;
    if (!viewport || job.media.length < 2) return;
    if (pendingMediaIndex.current !== null) {
      releaseMediaSelectionAfterScroll();
      return;
    }
    if (viewport.scrollWidth > viewport.clientWidth + 1 && viewport.scrollWidth - viewport.scrollLeft - viewport.clientWidth < 2) {
      setActiveMediaIndex(job.media.length - 1);
      return;
    }
    const bounds = viewport.getBoundingClientRect();
    const targetLeft = bounds.left + mediaInset;
    let nearest = 0;
    let distance = Infinity;
    mediaTileRefs.current.slice(0, job.media.length).forEach((tile, index) => {
      if (!tile) return;
      const rect = tile.getBoundingClientRect();
      if (rect.right <= bounds.left || rect.left >= bounds.right) return;
      const candidate = Math.abs(rect.left - targetLeft);
      if (candidate < distance) {
        nearest = index;
        distance = candidate;
      }
    });
    setActiveMediaIndex(nearest);
  }

  return (
    <article className={`job-card ${active ? 'is-active' : ''} ${historical ? 'is-history-post' : ''} ${selected ? 'is-selected' : ''}`}>
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
            {statusIcon(job.status)} {job.archived ? '已归档' : STATUS[job.status].label}
          </span>
          {historical && complete && job.media.length > 0 && (isNativeAndroid ? <button
            type="button"
            className="history-open-media"
            title={`打开 ${job.media[activeMediaIndex]?.filename ?? job.media[0].filename}`}
            aria-label={`打开 ${job.media[activeMediaIndex]?.filename ?? job.media[0].filename}`}
            onClick={() => onOpenMedia(job.media[activeMediaIndex] ?? job.media[0])}
          ><FolderOpen size={20} /></button> : <span className="history-save-actions">{activeMedia && <SaveLink media={activeMedia} className="text-button">保存</SaveLink>}{activeMedia && <ShareButton media={activeMedia} onNotice={onNotice} />}</span>)}
        </div>

        {job.metadata?.text && <p className="post-text">{job.metadata.text}</p>}
        {job.archived && <p className="archive-copy-status">
          {job.media.length > 0 && !job.unavailableMedia && job.media.every((media) => media.offlineReady)
            ? '本机可离线播放' : job.unavailableMedia ? `有 ${job.unavailableMedia} 个原文件缺失` : job.media.length ? '本机副本待补齐' : '暂无可播放文件'}
        </p>}
        {job.error && <div className="error-message"><CircleAlert size={15} />{job.error}</div>}

        {active && (
          <div className="progress-block">
            <div className="progress-copy">
              <span>{job.status === 'queued' ? '等待开始下载' : job.status === 'resolving' ? '正在读取帖子' : `正在保存 ${job.media.length} 个媒体文件`}</span>
              <strong>{job.progress}%</strong>
            </div>
            <div className="progress-track"><span style={{ width: `${job.progress}%` }} /></div>
          </div>
        )}

        {complete && job.media.length > 0 && (
          <div className={`media-carousel ${job.media.length === 1 ? 'is-single' : ''}`} aria-label={`此推文的 ${job.media.length} 个媒体文件`}>
            <div
              className="media-viewport"
              ref={mediaViewportRef}
              style={!mobileShell && activeMediaAspectRatio ? { aspectRatio: `${activeMediaAspectRatio}` } : undefined}
              onScroll={mobileShell ? updateActiveMedia : undefined}
              onTouchStart={mobileShell ? clearPendingMediaSelection : (event) => { touchStartX.current = event.touches[0]?.clientX ?? null; }}
              onTouchEnd={mobileShell ? undefined : (event) => {
                const startX = touchStartX.current;
                touchStartX.current = null;
                if (startX === null || job.media.length < 2) return;
                const delta = event.changedTouches[0].clientX - startX;
                if (Math.abs(delta) < 40) return;
                setActiveMediaIndex((index) => Math.max(0, Math.min(job.media.length - 1, index + (delta < 0 ? 1 : -1))));
              }}
              onTouchCancel={mobileShell ? undefined : () => { touchStartX.current = null; }}
            >
              <div className="media-track" style={!mobileShell ? { transform: `translateX(-${activeMediaIndex * 100}%)` } : undefined}>
                {job.media.map((media, index) => {
                  const preview = <MediaPreview media={media} controls={!historical} onAspectRatio={(ratio) => {
                      setMediaAspectRatios((current) => current[media.id] === ratio ? current : { ...current, [media.id]: ratio });
                    }} />;
                  return <div className="media-tile" key={media.id}
                    ref={(node) => { mediaTileRefs.current[index] = node; }}
                    style={mobileShell && job.media.length > 1 ? { aspectRatio: `${mediaAspectRatios[media.id] ?? 1}` } : undefined}
                  >
                    {mobileShell && historical
                      ? <button type="button" className="media-open-preview" aria-label={`预览 ${media.filename}`} onClick={() => onPreviewMedia(job.media, index)}>{preview}{media.kind === 'video' && <span className="media-play-badge" aria-hidden="true"><Play size={21} fill="currentColor" /></span>}</button>
                      : mobileShell && isNativeAndroid && (media.kind === 'image' || media.kind === 'gif')
                        ? <button type="button" className="media-open-preview" aria-label={`查看 ${media.filename}`} onClick={() => onOpenMedia(media)}>{preview}</button>
                      : preview}
                  </div>;
                })}
              </div>
            </div>
            {!historical && activeMedia && <div className="media-caption">
              <span>{activeMedia.kind === 'video' ? <Video size={13} /> : <ImageIcon size={13} />}{activeMedia.filename}</span>
              {isNativeAndroid
                ? <button type="button" title={`打开 ${activeMedia.filename}`} aria-label={`打开 ${activeMedia.filename}`} onClick={() => onOpenMedia(activeMedia)}><FolderOpen size={15} /></button>
                : <><SaveLink media={activeMedia} className="text-button">保存</SaveLink><ShareButton media={activeMedia} onNotice={onNotice} /></>}
            </div>}
            {job.media.length > 1 && <MediaPagination media={job.media} activeIndex={activeMediaIndex} ariaLabel="选择此推文的媒体文件" unit="个文件" onSelect={showMedia} />}
            {job.media.length > 1 && <span className="media-counter" aria-live="polite">{activeMediaIndex + 1} / {job.media.length}</span>}
          </div>
        )}
      </div>

      {historical && complete && (onClassify || selectionMode || canRecoverMedia) && <footer className="job-footer history-classification-actions">
        <span>{selectionMode && selected ? '已选中' : ''}</span>
        <div className="job-actions">
          {!selectionMode && canRecoverMedia && <button type="button" className="text-button" onClick={() => onAction('retry', job.id)}><RotateCcw size={14} />补下载原文件</button>}
          {selectionMode && <button type="button" className={`text-button ${selected ? 'is-picked' : ''}`} aria-pressed={selected} onClick={() => onToggleSelection?.(job.tweetId)}>
            {selected ? <Check size={15} /> : null}{selected ? '已选择' : '选择'}
          </button>}
          {onClassify && <button type="button" className="text-button history-classify-button" onClick={() => onClassify(job.tweetId)}><Tags size={15} />分类</button>}
        </div>
      </footer>}
      {!(historical && complete) && <footer className="job-footer">
        {!historical && <span>{job.media.length ? `${job.media.length} 个媒体 · ${formatBytes(totalSize || undefined)}` : `第 ${job.attempts || 1} 次尝试`}</span>}
        <div className="job-actions">
          {active && <button className="text-button danger-text" onClick={() => onAction('cancel', job.id)}><X size={15} />取消</button>}
          {(job.status === 'failed' || job.status === 'canceled') && <button className="text-button" onClick={() => onAction('retry', job.id)}><RotateCcw size={14} />重试</button>}
          {complete && job.media.length === 1 && !historical && (isNativeAndroid
            ? <button type="button" className="text-button" onClick={() => onOpenMedia(job.media[0])}><FolderOpen size={15} />打开文件</button>
            : <><SaveLink media={job.media[0]} className="text-button">保存</SaveLink><ShareButton media={job.media[0]} onNotice={onNotice} /></>)}
        </div>
      </footer>}
    </article>
  );
}
