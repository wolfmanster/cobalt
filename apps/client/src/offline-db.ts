import { archiveSessionKey } from './platform';

const name = 'cobalt-offline-archive';
let connection: Promise<IDBDatabase> | undefined;

function open() {
  return connection ??= new Promise<IDBDatabase>((resolve, reject) => {
    const pending = indexedDB.open(name, 1);
    pending.onupgradeneeded = () => {
      for (const store of ['state', 'files', 'chunks']) pending.result.createObjectStore(store);
    };
    pending.onsuccess = () => {
      pending.result.onversionchange = () => { pending.result.close(); connection = undefined; };
      resolve(pending.result);
    };
    pending.onerror = () => { connection = undefined; reject(pending.error); };
  });
}

export async function readOffline<T>(store: string, key: string): Promise<T | undefined> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const request = db.transaction(store).objectStore(store).get(key);
    request.onsuccess = () => resolve(request.result as T | undefined);
    request.onerror = () => reject(request.error);
  });
}

export async function writeOffline(entries: [string, string, unknown][], signal: AbortSignal) {
  if (!entries.length) return;
  const db = await open();
  signal.throwIfAborted();
  if (!localStorage.getItem(archiveSessionKey)) throw new DOMException('归档会话已退出', 'AbortError');
  return new Promise<void>((resolve, reject) => {
    const transaction = db.transaction([...new Set(entries.map(([store]) => store))], 'readwrite');
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error);
    try {
      for (const [store, key, value] of entries) transaction.objectStore(store).put(value, key);
    } catch (error) { transaction.abort(); reject(error); }
  });
}

export async function resetOffline() {
  const db = await open();
  return new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(['state', 'files', 'chunks'], 'readwrite');
    for (const store of ['state', 'files', 'chunks']) transaction.objectStore(store).clear();
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error);
  });
}
