import { Capacitor } from '@capacitor/core';

export const PWA_BUILD_ID = 'veo-pwa-1';

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
      if (waiting && navigator.serviceWorker.controller) onUpdate(() => {
        reloadOnControl = true;
        waiting.postMessage({ type: 'SKIP_WAITING' });
      });
    };
    announce();
    registration.addEventListener('updatefound', () => {
      registration.installing?.addEventListener('statechange', announce);
    });
  }).catch(() => undefined);
  return () => {
    disposed = true;
    navigator.serviceWorker.removeEventListener('controllerchange', onController);
  };
}
