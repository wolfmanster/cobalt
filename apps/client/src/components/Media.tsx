import { Capacitor } from '@capacitor/core';
import { useEffect, useState } from 'react';
import { webCopyBlob } from '../web-offline-media';
import type { MediaItem } from '../types';

function revealVideoPreview(video: HTMLVideoElement) {
  if (video.currentTime > 0 || !Number.isFinite(video.duration) || video.duration <= 0) return;
  video.currentTime = Math.min(0.05, video.duration / 2);
}

export function MediaPreview({ media, onAspectRatio, controls = true, loading = 'lazy' }: { media: MediaItem; onAspectRatio?: (ratio: number) => void; controls?: boolean; loading?: 'lazy' | 'eager' }) {
  if (!media.previewUrl) return <span>{media.filename} · 等待本机副本</span>;
  const previewUrl = Capacitor.convertFileSrc(media.previewUrl);
  const gifPlaysAsVideo = media.kind === 'gif' && (media.contentType ?? '').startsWith('video/');
  if ((media.kind === 'image' || media.kind === 'gif') && !gifPlaysAsVideo) {
    return <img src={previewUrl} alt={media.filename} loading={loading} onLoad={(event) => {
      const image = event.currentTarget;
      if (image.naturalWidth && image.naturalHeight) onAspectRatio?.(image.naturalWidth / image.naturalHeight);
    }} />;
  }
  return <VideoPreview media={media} previewUrl={previewUrl} controls={controls} onAspectRatio={onAspectRatio} />;
}

const prefersOfflineBlob = /iP(?:hone|ad|od)/.test(navigator.userAgent) ||
  (/AppleWebKit/.test(navigator.userAgent) && !/Chrome|Chromium|Edg/.test(navigator.userAgent));

function VideoPreview({ media, previewUrl, controls, onAspectRatio }: {
  media: MediaItem; previewUrl: string; controls: boolean; onAspectRatio?: (ratio: number) => void;
}) {
  const hash = controls && prefersOfflineBlob && media.previewUrl.startsWith('/__offline-media/') ? media.sha256 : undefined;
  const [local, setLocal] = useState<{ hash: string; url: string }>();
  useEffect(() => {
    if (!hash) return;
    const controller = new AbortController();
    let url = '';
    void webCopyBlob(hash, controller.signal).then((blob) => {
      if (controller.signal.aborted) return;
      if (blob) url = URL.createObjectURL(blob);
      setLocal({ hash, url });
    }).catch(() => { if (!controller.signal.aborted) setLocal({ hash, url: '' }); });
    return () => {
      controller.abort();
      if (url) URL.revokeObjectURL(url);
      setLocal(undefined);
    };
  }, [hash]);
  return (
    <video
      src={hash ? (local?.hash === hash ? local.url || previewUrl : undefined) : previewUrl}
      onError={() => {
        if (hash && local?.hash === hash && local.url) setLocal({ hash, url: '' });
      }}
      controls={controls}
      playsInline
      preload="metadata"
      onLoadedMetadata={(event) => {
        const video = event.currentTarget;
        revealVideoPreview(video);
        if (video.videoWidth && video.videoHeight) onAspectRatio?.(video.videoWidth / video.videoHeight);
      }}
    />
  );
}

export function MediaPagination({ media, activeIndex, ariaLabel, unit, onSelect }: {
  media: MediaItem[];
  activeIndex: number;
  ariaLabel: string;
  unit: string;
  onSelect: (index: number) => void;
}) {
  const maxDots = 7;
  const firstDot = Math.max(0, Math.min(activeIndex - Math.floor(maxDots / 2), media.length - maxDots));
  return <nav className="media-pagination" role="group" aria-label={ariaLabel}>
    {media.slice(firstDot, firstDot + maxDots).map((item, offset) => {
      const index = firstDot + offset;
      return <button
        key={item.id}
        type="button"
        className={index === activeIndex ? 'is-active' : ''}
        aria-label={`查看第 ${index + 1}${unit}，共 ${media.length}${unit}`}
        aria-current={index === activeIndex ? 'true' : undefined}
        onClick={() => onSelect(index)}
      />;
    })}
  </nav>;
}
