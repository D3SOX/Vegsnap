import bundled from '../../data/offline/bundle.json';
import { validateOfflineSnapshot, type OfflineSnapshot } from '@veguide/core';
import { createOfflineLibrary, type OfflinePackStorage } from './offline-library';

async function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('veguide-offline', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('packs', { keyPath: 'region' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error('Offline packs could not be opened.'));
  });
}
async function transaction(operation: 'read' | 'put' | 'remove', value?: OfflineSnapshot | string): Promise<unknown[]> {
  const db = await database();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction('packs', operation === 'read' ? 'readonly' : 'readwrite');
      const store = tx.objectStore('packs');
      let result: unknown[] = [];
      if (operation === 'read') { const read = store.getAll(); read.onsuccess = () => { result = read.result as unknown[]; }; }
      else if (operation === 'put') store.put(value);
      else store.delete(value as string);
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(new Error('Offline pack storage failed; existing packs were kept.'));
      tx.onabort = () => reject(new Error('Offline pack update was cancelled; existing packs were kept.'));
    });
  } finally { db.close(); }
}
const storage: OfflinePackStorage = {
  read: () => transaction('read'),
  put: async snapshot => { await transaction('put', snapshot); },
  remove: async region => { await transaction('remove', region); },
};
let library: ReturnType<typeof createOfflineLibrary> | undefined;
export function offlineLibrary() {
  return library ??= createOfflineLibrary(storage, validateOfflineSnapshot(bundled));
}
