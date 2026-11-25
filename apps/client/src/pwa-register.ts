import { Capacitor } from '@capacitor/core';

declare const __PWA_BUILD_ID__: string;
export const PWA_BUILD_ID = __PWA_BUILD_ID__;

function canServeOfflineMedia(worker: ServiceWorker | null | undefined) {
  const version = worker && new URL(worker.scriptURL).searchParams.get('v');
  return Boolean(version && version !== 'veo-pwa-1');
}

export function offlineMediaWorkerReady() {
  return canServeOfflineMedia(navigator.serviceWorker?.controller);
}

export function registerWebServiceWorker(onUpdate: (apply: () => void) => void): () => void {
  if (!import.meta.env.PROD || Capacitor.isNativePlatform() || !('serviceWorker' in navigator)) return () => undefined;
  let disposed = false;
  let reloadOnControl = false;
  const onController = () => {
    if (!reloadOnControl) return;
    reloadOnControl = false;
    window.location.reload();
  };
  navigator.serviceWorker.addEventListener('controllerchange', onController);
  void navigator.serviceWorker.register(`/sw.js?v=${PWA_BUILD_ID}`).then((registration) => {
    if (disposed) return;
    const announce = () => {
      const waiting = registration.waiting;
      const active = navigator.serviceWorker.controller;
      if (!waiting || !active) return;
      const apply = () => {
        reloadOnControl = true;
        waiting.postMessage({ type: 'SKIP_WAITING' });
      };
      if (!canServeOfflineMedia(active)) apply();
      else onUpdate(apply);
    };
    announce();
    registration.installing?.addEventListener('statechange', announce);
    registration.addEventListener('updatefound', () => {
      registration.installing?.addEventListener('statechange', announce);
    });
  }).catch(() => undefined);
  return () => {
    disposed = true;
    navigator.serviceWorker.removeEventListener('controllerchange', onController);
  };
}
