import { useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import type { useMediaViewer } from '../hooks/useMediaViewer';
import { MediaPagination, MediaPreview } from './Media';

export function HistoryMediaViewer({ viewer }: { viewer: ReturnType<typeof useMediaViewer> }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const opened = viewer.preview !== null;
  useEffect(() => {
    if (!opened) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus({ preventScroll: true });
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') viewer.close();
      if (event.key === 'Tab') {
        const dialog = closeRef.current?.closest('section');
        const controls = dialog?.querySelectorAll<HTMLElement>('button, video[controls]');
        if (!controls?.length) return;
        const first = controls[0];
        const last = controls[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      previousFocus?.focus({ preventScroll: true });
    };
  }, [opened, viewer.close]);

  const preview = viewer.preview;
  if (!preview || !preview.media[preview.index]) return null;
  return <section className="history-media-viewer" role="dialog" aria-modal="true"
    aria-label={`媒体预览：${preview.media[preview.index].filename}`}
    onTouchStart={viewer.startSwipe} onTouchMove={viewer.moveSwipe}
    onTouchEnd={viewer.finishSwipe} onTouchCancel={viewer.cancelSwipe}>
    <header className="history-media-viewer-header">
      <button ref={closeRef} type="button" className="history-media-viewer-close" onClick={viewer.close} aria-label="返回历史记录"><X size={24} /></button>
      <span>{preview.index + 1} / {preview.media.length}</span>
      <span className="history-media-viewer-header-spacer" aria-hidden="true" />
    </header>
    <div className="history-media-viewer-stage" ref={viewer.stageRef}>
      <div className={`history-media-viewer-track ${viewer.drag.animating ? 'is-settling' : ''}`}
        style={{ transform: `translate3d(calc(-33.333333% + ${viewer.drag.offsetX}px), 0, 0)` }}
        onTransitionEnd={(event) => {
          if (event.target === event.currentTarget && event.propertyName === 'transform') viewer.finishTransition();
        }}>
        {[-1, 0, 1].map((relativeIndex) => {
          const media = preview.media[preview.index + relativeIndex];
          return <div className="history-media-viewer-slide" key={media?.id ?? `empty-${relativeIndex}`} aria-hidden={relativeIndex === 0 ? undefined : true}>
            {media && <MediaPreview key={media.id} media={media} controls={relativeIndex === 0} loading="eager" />}
          </div>;
        })}
      </div>
    </div>
    {preview.media.length > 1 && <div className="history-media-viewer-pagination">
      <MediaPagination media={preview.media} activeIndex={preview.index} ariaLabel="选择推文媒体" unit="个媒体" onSelect={viewer.select} />
    </div>}
  </section>;
}
