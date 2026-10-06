import { normalizeBarcode } from './barcode';
export { normalizeBarcode } from './barcode';
import type { Category, CheckOptions, DatabaseProduct } from './types';
import { readBoundedText } from './http';

export const DATABASES = [
  { id: 'off', name: 'Open Food Facts', origin: 'https://world.openfoodfacts.org', category: 'food' },
  { id: 'obf', name: 'Open Beauty Facts', origin: 'https://world.openbeautyfacts.org', category: 'cosmetics' },
  { id: 'opf', name: 'Open Products Facts', origin: 'https://world.openproductsfacts.org', category: 'other' },
] as const;
const FIELDS = 'code,product_name,product_name_de,brands,ingredients_text,ingredients_text_de,countries_tags,labels_tags,last_modified_t';
type LookupOptions = Pick<CheckOptions, 'fetch' | 'signal' | 'now'> & { category?: Category; market?: string; locale?: 'de' | 'en' };
type Entry = { expires: number; value: DatabaseProduct | null };
type ClientState = { cache: Map<string, Entry>; requests: Map<string, number[]> };
const clients = new WeakMap<typeof fetch, ClientState>();

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function string(value: unknown): string | undefined { return typeof value === 'string' && value.trim() ? value.trim() : undefined; }
function list(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []; }

/** Exact GTIN only: no fuzzy title matches, no search-as-you-type or image downloads. */
export async function lookupProduct(barcode: string, options: LookupOptions = {}): Promise<DatabaseProduct | null> {
  const code = normalizeBarcode(barcode);
  if (!code) throw new Error('Invalid GTIN/EAN: check the digits and checksum.');
  const fetcher = options.fetch ?? globalThis.fetch;
  let state = clients.get(fetcher);
  if (!state) { state = { cache: new Map(), requests: new Map() }; clients.set(fetcher, state); }
  const now = options.now ?? (() => new Date());
  const preferred = options.category === 'cosmetics' ? 'obf' : ['clothing', 'shoes', 'household', 'other'].includes(options.category ?? '') ? 'opf' : 'off';
  const databases = [...DATABASES].sort((a, b) => Number(b.id === preferred) - Number(a.id === preferred));
  const errors: string[] = [];
  for (const db of databases) {
    options.signal?.throwIfAborted();
    const key = `${db.id}:${code}:${options.locale ?? 'en'}:${options.market ?? 'DE'}:${options.category ?? ''}`;
    const cached = state.cache.get(key);
    if (cached && cached.expires > now().getTime()) {
      if (cached.value) return structuredClone(cached.value);
      continue;
    }
    const recent = (state.requests.get(db.id) ?? []).filter(time => now().getTime() - time < 60_000);
    if (recent.length >= 15) { errors.push(`${db.name}: request limit reached; try again in a minute.`); continue; }
    recent.push(now().getTime()); state.requests.set(db.id, recent);
    const url = new URL(`/api/v3/product/${code}.json`, db.origin);
    url.searchParams.set('fields', FIELDS);
    // Browser fetch cannot reliably override User-Agent; app identification remains in the URL.
    url.searchParams.set('app_name', 'Vegsnap'); url.searchParams.set('app_version', '0.1.0');
    try {
      const response = await fetcher(url.href, {
        headers: { Accept: 'application/json' }, credentials: 'omit', redirect: 'error',
        signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(12_000)]) : AbortSignal.timeout(12_000),
      });
      if (response.status === 404) { remember(state, key, null, now().getTime() + 300_000); continue; }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const raw: unknown = JSON.parse(await readBoundedText(response, 1_048_576));
      const envelope = record(raw);
      const product = record(envelope?.product);
      if (!product) {
        if (envelope?.status === 0 || envelope?.status === 'failure' || envelope?.status === 'not_found') {
          remember(state, key, null, now().getTime() + 300_000); continue;
        }
        throw new Error('Invalid product response');
      }
      const returnedCode = string(product.code);
      if (!returnedCode || !normalizeBarcode(returnedCode) || returnedCode.padStart(14, '0') !== code.padStart(14, '0')) throw new Error('Product identifier mismatch');
      const markets = list(product.countries_tags);
      const requestedMarket = (options.market ?? 'DE').toUpperCase();
      if (requestedMarket === 'DE' && markets.length > 0 && !markets.includes('en:germany')) {
        throw new Error('The database record does not list Germany; confirm the market before using it.');
      }
      const text = options.locale === 'de' ? string(product.ingredients_text_de) ?? string(product.ingredients_text) : string(product.ingredients_text) ?? string(product.ingredients_text_de);
      const name = options.locale === 'de' ? string(product.product_name_de) ?? string(product.product_name) : string(product.product_name) ?? string(product.product_name_de);
      const modified = typeof product.last_modified_t === 'number' && Number.isFinite(product.last_modified_t) ? new Date(product.last_modified_t * 1000) : undefined;
      const value: DatabaseProduct = {
        input: { barcode: code, name, brand: string(product.brands), text, complete: false,
          category: options.category && options.category !== 'other' ? options.category : db.category,
          locale: options.locale, market: requestedMarket, sourceUrl: `${db.origin}/product/${code}` },
        evidence: { id: `${db.id}:${code}`, kind: 'database', title: db.name, excerpt: text ?? name ?? code,
          url: `${db.origin}/product/${code}`, retrievedAt: now().toISOString(),
          ...(modified && !Number.isNaN(modified.getTime()) ? { sourceDate: modified.toISOString() } : {}),
          license: 'ODbL-1.0 (database); DBCL-1.0 (contents)' },
        labels: list(product.labels_tags),
      };
      remember(state, key, value, now().getTime() + 86_400_000);
      return structuredClone(value);
    } catch (error) {
      if (options.signal?.aborted) throw error;
      errors.push(`${db.name}: ${error instanceof Error ? error.message : 'lookup failed'}`);
    }
  }
  if (errors.length) throw new Error(errors.join(' '));
  return null;
}
function remember(state: ClientState, key: string, value: DatabaseProduct | null, expires: number) {
  if (state.cache.size >= 100) {
    const oldest = state.cache.keys().next().value;
    if (oldest) state.cache.delete(oldest);
  }
  state.cache.set(key, { value, expires });
}
