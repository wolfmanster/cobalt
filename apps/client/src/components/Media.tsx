import { Capacitor } from '@capacitor/core';
import type { MediaItem } from '../types';

function revealVideoPreview(video: HTMLVideoElement) {
  if (video.currentTime > 0 || !Number.isFinite(video.duration) || video.duration <= 0) return;
  video.currentTime = Math.min(0.05, video.duration / 2);
}

export function MediaPreview({ media, onAspectRatio, controls = true, loading = 'lazy' }: { media: MediaItem; onAspectRatio?: (ratio: number) => void; controls?: boolean; loading?: 'lazy' | 'eager' }) {
  const previewUrl = Capacitor.convertFileSrc(media.previewUrl);
  if (media.kind === 'image' || media.kind === 'gif') {
    return <img src={previewUrl} alt={media.filename} loading={loading} onLoad={(event) => {
      const image = event.currentTarget;
      if (image.naturalWidth && image.naturalHeight) onAspectRatio?.(image.naturalWidth / image.naturalHeight);
    }} />;
  }
  return (
    <video
      src={previewUrl}
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
