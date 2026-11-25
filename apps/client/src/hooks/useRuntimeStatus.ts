import { useEffect, useState } from 'react';
import { getHealth } from '../api';
import { isNativeAndroid, usesLocalArchive } from '../platform';
import { subscribeServiceWorkerUpdate } from '../pwa-update';

export function useRuntimeStatus() {
  const [serviceHealthy, setServiceHealthy] = useState<boolean | null>(null);
  const [offline, setOffline] = useState(!isNativeAndroid && typeof navigator !== 'undefined' && navigator.onLine === false);
  const [applyUpdate, setApplyUpdate] = useState<(() => void) | null>(null);

  useEffect(() => {
    let disposed = false;
    const refreshHealth = async () => {
      try {
        const health = await getHealth();
        if (!disposed) setServiceHealthy(usesLocalArchive ? Boolean(health.ok && health.local) : Boolean(health.ok && health.cobalt));
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

  useEffect(() => {
    if (isNativeAndroid) return;
    const show = () => setOffline(true);
    const hide = () => setOffline(false);
    window.addEventListener('offline', show);
    window.addEventListener('online', hide);
    return () => {
      window.removeEventListener('offline', show);
      window.removeEventListener('online', hide);
    };
  }, []);

  useEffect(() => subscribeServiceWorkerUpdate((apply) => setApplyUpdate(() => apply)), []);

  return { serviceHealthy, offline, applyUpdate };
}
