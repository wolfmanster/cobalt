let pendingUpdate: (() => void) | null = null;
const listeners = new Set<(apply: (() => void) | null) => void>();

export function publishServiceWorkerUpdate(apply: () => void) {
  pendingUpdate = apply;
  for (const listener of listeners) listener(apply);
}

export function subscribeServiceWorkerUpdate(listener: (apply: (() => void) | null) => void) {
  listeners.add(listener);
  listener(pendingUpdate);
  return () => { listeners.delete(listener); };
}
