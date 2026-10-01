import { useCallback, useEffect, useRef, useState, type TouchEvent } from 'react';
import type { MediaItem } from '../types';

export function useMediaViewer() {
  const [historyPreview, setHistoryPreview] = useState<{ media: MediaItem[]; index: number } | null>(null);
  const [historyPreviewDrag, setHistoryPreviewDrag] = useState({ offsetX: 0, animating: false });
  const historyPreviewRef = useRef<{ media: MediaItem[]; index: number } | null>(null);
  const historyPreviewDragRef = useRef({ offsetX: 0, animating: false });
  const historyPreviewStageRef = useRef<HTMLDivElement | null>(null);
  const historyPreviewPendingIndex = useRef<number | null>(null);
  const historyPreviewTransitionTimer = useRef<number | null>(null);
  const historyPreviewScrollY = useRef<number | null>(null);
  const historyPreviewTouch = useRef<{ x: number; y: number; edge: boolean; axis: 'horizontal' | 'vertical' | null } | null>(null);
  const historyPreviewOpen = historyPreview !== null;

  function updateHistoryPreviewDrag(next: { offsetX: number; animating: boolean }) {
    historyPreviewDragRef.current = next;
    setHistoryPreviewDrag(next);
  }

  function clearHistoryPreviewTransitionTimer() {
    if (historyPreviewTransitionTimer.current !== null) {
      window.clearTimeout(historyPreviewTransitionTimer.current);
      historyPreviewTransitionTimer.current = null;
    }
  }

  function finishHistoryPreviewTransition() {
    clearHistoryPreviewTransitionTimer();
    const targetIndex = historyPreviewPendingIndex.current;
    const current = historyPreviewRef.current;
    if (targetIndex !== null && current) {
      const next = { ...current, index: targetIndex };
      historyPreviewRef.current = next;
      setHistoryPreview(next);
    }
    historyPreviewPendingIndex.current = null;
    updateHistoryPreviewDrag({ offsetX: 0, animating: false });
  }

  function settleHistoryPreviewTrack(targetIndex: number | null, offsetX: number) {
    clearHistoryPreviewTransitionTimer();
    historyPreviewPendingIndex.current = targetIndex;
    updateHistoryPreviewDrag({ offsetX, animating: true });
    historyPreviewTransitionTimer.current = window.setTimeout(finishHistoryPreviewTransition, 260);
  }

  function previewHistoryMedia(media: MediaItem[], index: number) {
    if (!media.length) return;
    const next = { media, index: Math.max(0, Math.min(media.length - 1, index)) };
    clearHistoryPreviewTransitionTimer();
    historyPreviewPendingIndex.current = null;
    historyPreviewTouch.current = null;
    updateHistoryPreviewDrag({ offsetX: 0, animating: false });
    historyPreviewScrollY.current = window.scrollY;
    historyPreviewRef.current = next;
    setHistoryPreview(next);
  }

  const closeHistoryPreview = useCallback(() => {
    clearHistoryPreviewTransitionTimer();
    historyPreviewPendingIndex.current = null;
    historyPreviewTouch.current = null;
    updateHistoryPreviewDrag({ offsetX: 0, animating: false });
    historyPreviewRef.current = null;
    setHistoryPreview(null);
  }, []);

  function selectHistoryPreview(index: number) {
    const current = historyPreviewRef.current;
    if (!current) return;
    clearHistoryPreviewTransitionTimer();
    historyPreviewPendingIndex.current = null;
    historyPreviewTouch.current = null;
    const next = {
      ...current,
      index: Math.max(0, Math.min(current.media.length - 1, index)),
    };
    updateHistoryPreviewDrag({ offsetX: 0, animating: false });
    historyPreviewRef.current = next;
    setHistoryPreview(next);
  }

  function startHistoryPreviewSwipe(event: TouchEvent<HTMLElement>) {
    if (historyPreviewDragRef.current.animating) return;
    const touch = event.touches[0];
    if (!touch) return;
    historyPreviewTouch.current = {
      x: touch.clientX,
      y: touch.clientY,
      edge: touch.clientX <= 24 || touch.clientX >= window.innerWidth - 24,
      axis: null,
    };
  }

  function moveHistoryPreviewSwipe(event: TouchEvent<HTMLElement>) {
    const start = historyPreviewTouch.current;
    const touch = event.touches[0];
    const current = historyPreviewRef.current;
    if (!start || start.edge || !touch || !current || current.media.length < 2 || historyPreviewDragRef.current.animating) return;
    const deltaX = touch.clientX - start.x;
    const deltaY = touch.clientY - start.y;
    if (Math.abs(deltaX) < 8) return;
    if (Math.abs(deltaX) < Math.abs(deltaY) * 1.25) {
      start.axis = 'vertical';
      return;
    }
    start.axis = 'horizontal';
    const hasNeighbor = deltaX < 0 ? current.index < current.media.length - 1 : current.index > 0;
    const offsetX = hasNeighbor ? deltaX : Math.sign(deltaX) * Math.min(Math.abs(deltaX) * 0.22, 72);
    updateHistoryPreviewDrag({ offsetX, animating: false });
  }

  function finishHistoryPreviewSwipe(event: TouchEvent<HTMLElement>) {
    const start = historyPreviewTouch.current;
    historyPreviewTouch.current = null;
    const touch = event.changedTouches[0];
    const current = historyPreviewRef.current;
    if (!start) return;
    if (start.edge || !current || current.media.length < 2) {
      updateHistoryPreviewDrag({ offsetX: 0, animating: false });
      return;
    }
    if (!touch) {
      settleHistoryPreviewTrack(null, 0);
      return;
    }
    const deltaX = touch.clientX - start.x;
    const deltaY = touch.clientY - start.y;
    if (start.axis !== 'horizontal' || Math.abs(deltaX) < 48 || Math.abs(deltaX) < Math.abs(deltaY) * 1.25) {
      if (historyPreviewDragRef.current.offsetX !== 0) settleHistoryPreviewTrack(null, 0);
      else updateHistoryPreviewDrag({ offsetX: 0, animating: false });
      return;
    }
    const direction = deltaX < 0 ? 1 : -1;
    const targetIndex = Math.max(0, Math.min(current.media.length - 1, current.index + direction));
    if (targetIndex === current.index) {
      settleHistoryPreviewTrack(null, 0);
      return;
    }
    const stage = historyPreviewStageRef.current;
    const stageStyles = stage ? window.getComputedStyle(stage) : null;
    const stageWidth = stage
      ? stage.clientWidth - Number.parseFloat(stageStyles?.paddingLeft ?? '0') - Number.parseFloat(stageStyles?.paddingRight ?? '0')
      : window.innerWidth;
    settleHistoryPreviewTrack(targetIndex, direction > 0 ? -stageWidth : stageWidth);
  }

  function cancelHistoryPreviewSwipe() {
    const start = historyPreviewTouch.current;
    historyPreviewTouch.current = null;
    if (start && !start.edge) settleHistoryPreviewTrack(null, 0);
  }

  useEffect(() => () => {
    if (historyPreviewTransitionTimer.current !== null) {
      window.clearTimeout(historyPreviewTransitionTimer.current);
    }
  }, []);

  useEffect(() => {
    if (!historyPreviewOpen) return;
    const scrollY = historyPreviewScrollY.current ?? window.scrollY;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousOverflow;
      historyPreviewScrollY.current = null;
      window.scrollTo({ top: scrollY, behavior: 'auto' });
    };
  }, [historyPreviewOpen]);

  const closeIfOpen = useCallback(() => {
    if (!historyPreviewRef.current) return false;
    closeHistoryPreview();
    return true;
  }, [closeHistoryPreview]);

  return {
    preview: historyPreview, drag: historyPreviewDrag, stageRef: historyPreviewStageRef,
    open: previewHistoryMedia, close: closeHistoryPreview, closeIfOpen, select: selectHistoryPreview,
    startSwipe: startHistoryPreviewSwipe, moveSwipe: moveHistoryPreviewSwipe,
    finishSwipe: finishHistoryPreviewSwipe, cancelSwipe: cancelHistoryPreviewSwipe,
    finishTransition: finishHistoryPreviewTransition,
  };
}
