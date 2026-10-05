import type { CheckResult } from '@veguide/core';
export interface HistoryResult extends CheckResult { photos?: string[]; }
export function historyExport(results: HistoryResult[]): CheckResult[] {
  return results.map(({ photos: _photos, ...result }) => result);
}
const DB_NAME = 'veguide';
function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore('checks', { keyPath: 'id' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error('Local history could not be opened.'));
  });
}
export async function history(operation: 'list'): Promise<HistoryResult[]>;
export async function history(operation: 'save', value: HistoryResult): Promise<void>;
export async function history(operation: 'delete', value?: string): Promise<void>;
export async function history(operation: 'list' | 'save' | 'delete', value?: HistoryResult | string): Promise<HistoryResult[] | void> {
  const db = await database();
  try {
    return await new Promise<HistoryResult[] | void>((resolve, reject) => {
      const transaction = db.transaction('checks', operation === 'list' ? 'readonly' : 'readwrite');
      const store = transaction.objectStore('checks');
      let results: HistoryResult[] | undefined;
      if (operation === 'list') { const request = store.getAll(); request.onsuccess = () => { results = (request.result as HistoryResult[]).sort((a, b) => b.checkedAt.localeCompare(a.checkedAt)); }; }
      else if (operation === 'save' && typeof value === 'object') store.put(value);
      else if (typeof value === 'string') store.delete(value);
      else store.clear();
      transaction.oncomplete = () => resolve(results);
      transaction.onerror = () => reject(new Error('Local history could not be updated.'));
      transaction.onabort = () => reject(new Error('Local history update was cancelled.'));
    });
  } finally { db.close(); }
}
