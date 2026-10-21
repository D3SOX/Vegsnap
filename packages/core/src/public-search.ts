import { readBoundedText } from './http';

export type PublicSearchFailure = 'rate_limited' | 'temporarily_unavailable' | 'timeout' | 'connection' | 'unavailable';
/** A classified public-database search failure; clients map the reason to their own copy. */
export class PublicSearchError extends Error {
  constructor(readonly reason: PublicSearchFailure, message: string) { super(message); this.name = 'PublicSearchError'; }
}
function classify(error: unknown): PublicSearchError {
  if (error instanceof PublicSearchError) return error;
  if (error instanceof DOMException && error.name === 'TimeoutError') return new PublicSearchError('timeout', 'The database took too long to respond.');
  if (error instanceof TypeError) return new PublicSearchError('connection', 'Could not connect to the database.');
  return new PublicSearchError('unavailable', error instanceof Error ? error.message : 'Could not load this database.');
}
// Open Facts search endpoints allow 10 searches/minute per client. Every submitted search
// (alternatives and browsing alike) shares one queue, is paced, and is cached briefly.
let queue = Promise.resolve();
let lastStarted = 0;
const cache = new Map<string, { expires: number; document: unknown }>();
export async function fetchPublicSearch(url: string, fetcher: typeof fetch, signal: AbortSignal | undefined, validate: (document: unknown) => void): Promise<unknown> {
  const run = queue.catch(() => {}).then(async () => {
    signal?.throwIfAborted();
    const cached = cache.get(url);
    if (cached && cached.expires > Date.now()) return cached.document;
    // A clock that moved backwards cannot prove a recent request; only a measured gap delays the search.
    const elapsed = Date.now() - lastStarted;
    const wait = elapsed >= 0 && elapsed < 6100 ? 6100 - elapsed : 0;
    if (wait) await new Promise<void>(resolve => setTimeout(resolve, wait));
    signal?.throwIfAborted(); lastStarted = Date.now();
    try {
      const response = await fetcher(url, { credentials: 'omit', redirect: 'error', headers: { Accept: 'application/json' },
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(35000)]) : AbortSignal.timeout(35000) });
      if (response.status === 429) throw new PublicSearchError('rate_limited', 'Product search returned HTTP 429.');
      if (response.status === 408 || response.status === 504) throw new PublicSearchError('timeout', `Product search returned HTTP ${response.status}.`);
      if (response.status >= 500) throw new PublicSearchError('temporarily_unavailable', `Product search returned HTTP ${response.status}.`);
      if (!response.ok) throw new PublicSearchError('unavailable', `Product search returned HTTP ${response.status}.`);
      const document: unknown = JSON.parse(await readBoundedText(response, 2000000));
      validate(document);
      if (cache.size >= 20) cache.delete(cache.keys().next().value!);
      cache.set(url, { expires: Date.now() + 300000, document });
      return document;
    } catch (error) {
      if (signal?.aborted) throw error;
      throw classify(error);
    }
  });
  queue = run.then(() => {}, () => {});
  return run;
}
