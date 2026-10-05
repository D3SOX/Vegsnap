import { browser } from 'wxt/browser';
import { parseAIExtraction, validateAIExtraction, type ProviderAdapter } from '@veguide/core';
import { isRecord } from './protocol';
let nativeQueue = Promise.resolve();
/** Native processes share one OS session lock, including inference and read-only status. */
export function companion(command: string, payload?: unknown, signal?: AbortSignal): Promise<unknown> {
  const request = nativeQueue.catch(() => {}).then(() => sendCompanion(command, payload, signal));
  nativeQueue = request.then(() => {}, () => {});
  if (!signal) return request;
  // A cancelled queued check returns immediately; its queue slot later skips native startup.
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new DOMException('Cancelled', 'AbortError'));
    if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
    void request.then(result => { signal.removeEventListener('abort', abort); resolve(result); }, error => { signal.removeEventListener('abort', abort); reject(error); });
  });
}
async function sendCompanion(command: string, payload?: unknown, signal?: AbortSignal): Promise<unknown> {
  signal?.throwIfAborted();
  if (!(await browser.permissions.contains({ permissions: ['nativeMessaging'] }))) throw new Error('Enable the desktop companion in settings first.');
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    const port = browser.runtime.connectNative('org.veguide.companion');
    let settled = false;
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
    const abort = () => { settled = true; cleanup(); port.disconnect(); reject(new DOMException('Cancelled', 'AbortError')); };
    const timer = setTimeout(() => { settled = true; cleanup(); port.disconnect(); reject(new Error('Companion request timed out.')); }, command === 'signIn' ? 360_000 : 150_000);
    signal?.addEventListener('abort', abort, { once: true });
    port.onMessage.addListener((message: unknown) => {
      if (!isRecord(message) || message.id !== id) return;
      settled = true; cleanup(); port.disconnect();
      if (message.ok === true) resolve(message.result);
      else reject(new Error(typeof message.error === 'string' ? message.error : 'Companion request failed.'));
    });
    port.onDisconnect.addListener(() => { cleanup(); if (!settled) reject(new Error('The desktop companion is unavailable. Install it or choose an API provider.')); });
    port.postMessage({ id, command, ...(payload === undefined ? {} : { payload }) });
  });
}
export function companionProvider(model: string, supportsImages = true): ProviderAdapter {
  return { supportsWebSearch: true, async extract(input, signal) {
    if (input.images?.length && !supportsImages) throw new Error('Choose a vision-capable model for photo checks.');
    const value = await companion('check', { model, text: JSON.stringify({ text: input.text ?? '', name: input.name, brand: input.brand, sourceUrl: input.sourceUrl, category: input.category, market: input.market ?? 'DE', locale: input.locale ?? 'en', complete: input.complete }), ...(input.images?.length ? { imageDataUrls: input.images } : {}) }, signal);
    if (!isRecord(value) || typeof value.text !== 'string') throw new Error('The companion returned an invalid response.');
    return validateAIExtraction({ ...parseAIExtraction(value.text), ...(value.research === undefined ? {} : { research: value.research }) }, { allowResearch: true });
  } };
}
