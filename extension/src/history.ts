import type { CheckInput, CheckResult } from '@vegsnap/core';
export interface HistoryResult extends CheckResult { photos?: string[]; input?: Omit<CheckInput, 'images'>; }
/** Older checks only retain supplied text, not the full original input. */
export function editableInput(result: HistoryResult): CheckInput {
  return {
    text: [...new Set(result.evidence.filter(item => item.kind === 'user_text').map(item => item.excerpt))].join('\n').slice(0, 30_000),
    category: result.category,
    ...result.input,
    name: result.input?.name ?? result.identity.name, brand: result.input?.brand ?? result.identity.brand,
    barcode: result.input?.barcode ?? result.identity.barcode, market: result.identity.marketSource === 'manual' ? result.identity.market : result.input?.market ?? result.identity.market,
    ...(result.identity.marketSource === 'manual' ? {autoMarket:false} : {}),
    images: [...(result.photos ?? [])],
  };
}
export function historyExport(results: HistoryResult[]): CheckResult[] {
  return results.map(({ photos: _photos, input: _input, ...result }) => result);
}
const DB_NAME = 'vegsnap';
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
