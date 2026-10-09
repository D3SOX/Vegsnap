// Minimal host adapters for APIs used by @vegsnap/core. No DOM or web renderer.
globalThis.crypto = { randomUUID: () => nativeUUID() };
globalThis.structuredClone = value => JSON.parse(JSON.stringify(value));
globalThis.TextEncoder = class { encode(text) { return { length: nativeByteCount(text), byteLength: nativeByteCount(text) }; } };
globalThis.TextDecoder = class { decode(chunk) { return chunk ? chunk.text : ''; } };
globalThis.URLSearchParams = class {
  constructor(value = '') { this.items = typeof value === 'string' ? value.replace(/^\?/, '').split('&').filter(Boolean).map(p => p.split('=').map(s => decodeURIComponent(s.replace(/\+/g, ' ')))) : Object.entries(value); }
  set(k, v) { this.items = this.items.filter(p => p[0] !== k); this.items.push([k, String(v)]); this.changed?.(); }
  get(k) { return this.items.find(p => p[0] === k)?.[1] ?? null; }
  toString() { return this.items.map(p => p.map(encodeURIComponent).join('=')).join('&'); }
};
globalThis.URL = class {
  constructor(value, base) {
    const parts = JSON.parse(nativeURL(String(value), base ? String(base) : ''));
    if (!parts) throw new TypeError('Invalid URL');
    Object.assign(this, parts);
    this.searchParams = new URLSearchParams(this.search);
    this.searchParams.changed = () => { this.search = this.searchParams.toString() ? '?' + this.searchParams : ''; this.href = this.origin + this.pathname + this.search + this.hash; };
  }
  toString() { return this.href; }
};
globalThis.AbortSignal = class {
  constructor() { this.aborted = false; this.listeners = []; }
  addEventListener(_, listener) { this.listeners.push(listener); }
  removeEventListener(_, listener) { this.listeners = this.listeners.filter(l => l !== listener); }
  throwIfAborted() { if (this.aborted) throw new Error('Cancelled'); }
  static timeout(ms) { const c = new AbortController(); nativeTimer(ms, () => c.abort()); return c.signal; }
  static any(signals) { const c = new AbortController(); for (const s of signals) { if (s.aborted) c.abort(); else s.addEventListener('abort', () => c.abort()); } return c.signal; }
};
globalThis.AbortController = class {
  constructor() { this.signal = new AbortSignal(); }
  abort() { if (!this.signal.aborted) { this.signal.aborted = true; this.signal.listeners.forEach(l => l()); } }
};
globalThis.fetch = (url, options = {}) => new Promise((resolve, reject) => {
  options.signal?.throwIfAborted();
  const id = crypto.randomUUID();
  const abort = () => { nativeCancelFetch(id); reject(new Error('Cancelled')); };
  options.signal?.addEventListener('abort', abort);
  nativeFetch(id, String(url), JSON.stringify({ method: options.method || 'GET', headers: options.headers || {}, body: options.body, chatGPT: options.chatGPT === true }), (status, text, error) => {
    options.signal?.removeEventListener('abort', abort);
    if (error) { reject(new Error(error)); return; }
    let read = false;
    resolve({ status, ok: status >= 200 && status < 300, body: { getReader: () => ({
      read: async () => { if (read) return { done: true }; read = true; return { done: false, value: { text, byteLength: nativeByteCount(text) } }; },
      cancel: async () => {}, releaseLock: () => {}
    }) } });
  });
});

globalThis.chatGPTFetch = (url, options = {}) => {
  const body = JSON.parse(options.body);
  body.stream = true;
  delete body.max_output_tokens; delete body.max_tool_calls;
  return fetch(url, { ...options, body: JSON.stringify(body), chatGPT: true });
};
