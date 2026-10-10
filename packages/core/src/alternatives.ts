import type { AIExtraction, Category, Locale, ProviderAdapter } from './types';
import { DATABASES } from './database';
import { countryCode } from './market';
import { analyzeText, safeSourceUrl } from './analyze';
import { readBoundedText } from './http';

export interface AlternativeSearch {
  query: string; store?: string; category: Category; market: string; locale?: Locale; excludeBarcode?: string;
}
export interface VeganAlternative {
  id: string; name: string; brand: string; url: string; barcode?: string;
  source: string; evidence: string; storeMatch: boolean; stores: string[]; storeUrl?: string;
  marketListed: boolean;
}
const key = (value: string) => value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string').slice(0, 100) : [];
const text = (value: unknown, maximum = 300) => typeof value === 'string' ? value.trim().slice(0, maximum) : '';
const veganLabels = new Set(['en:vegan', 'en:vegan-society', 'en:vegan-society-approved', 'en:v-label-vegan', 'en:certified-vegan']);
/** Start with the product type rather than requiring the substitute to share its brand/animal ingredient. */
export function alternativeQueryForProduct(name: string, brand = '', animalTerms: string[] = []): string {
  const omit = new Set([brand, ...animalTerms].flatMap(value => key(value).split(' ')).filter(Boolean));
  const words = name.match(/[\p{L}\p{N}]+/gu) ?? [];
  const query = words.filter(word => !omit.has(key(word))).join(' ');
  return (query.length >= 2 ? query : name).slice(0, 200);
}
export function validateAlternativeSearch(input: AlternativeSearch): AlternativeSearch {
  if (!object(input) || typeof input.query !== 'string' || input.query.trim().length < 2 || input.query.length > 200 ||
    input.store !== undefined && (typeof input.store !== 'string' || input.store.length > 100) ||
    !['food', 'drink', 'cosmetics', 'household', 'clothing', 'shoes', 'other'].includes(input.category) || countryCode(input.market) !== input.market ||
    input.locale !== undefined && !['en', 'de'].includes(input.locale) ||
    input.excludeBarcode !== undefined && (typeof input.excludeBarcode !== 'string' || !/^\d{8,14}$/.test(input.excludeBarcode))) throw new Error('Invalid alternative search.');
  return { ...input, query: input.query.trim(), store: input.store?.trim() || undefined };
}
function database(input: AlternativeSearch) {
  return DATABASES.find(db => db.id === (input.category === 'cosmetics' ? 'obf' : ['food', 'drink'].includes(input.category) ? 'off' : 'opf'))!;
}
export function alternativeSearchUrl(raw: AlternativeSearch, storeOnly = false): string {
  const input = validateAlternativeSearch(raw), db = database(input);
  const url = new URL('/cgi/search.pl', db.origin);
  const params: Record<string, string> = { search_terms: input.query, search_simple: '1', action: 'process', json: '1', page_size: '40',
    tagtype_0: 'labels', tag_contains_0: 'contains', tag_0: 'vegan',
    fields: 'code,product_name,product_name_de,brands,ingredients_text,ingredients_text_de,labels_tags,ingredients_analysis_tags,countries_tags,stores,stores_tags,categories_tags',
    lc: input.locale ?? 'en' };
  if (storeOnly && input.store) Object.assign(params, { tagtype_1: 'stores', tag_contains_1: 'contains', tag_1: input.store });
  Object.entries(params).forEach(([name, value]) => url.searchParams.set(name, value));
  return url.href;
}
export function parsePublicAlternatives(document: unknown, raw: AlternativeSearch): VeganAlternative[] {
  const input = validateAlternativeSearch(raw), db = database(input);
  if (!object(document) || !Array.isArray(document.products) || document.error || document.errors) throw new Error('Invalid product search response.');
  const items: VeganAlternative[] = [];
  for (const product of document.products.slice(0, 40)) {
    if (!object(product)) continue;
    const code = text(product.code, 30), name = text(input.locale === 'de' ? product.product_name_de || product.product_name : product.product_name || product.product_name_de);
    if (!/^\d{8,14}$/.test(code) || !name || code.padStart(14, '0') === input.excludeBarcode?.padStart(14, '0')) continue;
    const labels = strings(product.labels_tags), analysis = strings(product.ingredients_analysis_tags);
    if (!labels.some(label => veganLabels.has(label)) || analysis.includes('en:non-vegan')) continue;
    const composition = text(product.ingredients_text || product.ingredients_text_de, 20000);
    if (composition && analyzeText({ text: composition, category: input.category }).outcome === 'not_vegan') continue;
    const countries = strings(product.countries_tags).map(countryCode).filter(Boolean);
    if (countries.length && !countries.includes(input.market)) continue;
    const stores = text(product.stores, 1000).split(/[,;]/).map(value => value.trim()).filter(Boolean);
    const storeKeys = [...stores, ...strings(product.stores_tags)].map(key);
    const storeMatch = !!input.store && storeKeys.includes(key(input.store));
    items.push({ id: `${db.id}:${code}`, barcode: code, name, brand: text(product.brands), url: `${db.origin}/product/${code}`,
      source: db.name, evidence: labels.filter(label => veganLabels.has(label)).join(', '),
      stores: stores.length ? stores : storeMatch ? [input.store!] : [], storeMatch, marketListed: countries.includes(input.market) });
  }
  return rankAlternatives(items, input);
}
export function rankAlternatives(items: VeganAlternative[], input: AlternativeSearch): VeganAlternative[] {
  const tokens = key(input.query).split(' ').filter(word => word.length > 1);
  const score = (item: VeganAlternative) => Number(item.storeMatch) * 1000 + Number(item.marketListed) * 100 +
    tokens.filter(word => key(item.name).split(' ').includes(word)).length;
  const unique = new Map<string, VeganAlternative>();
  for (const item of items) {
    const id = item.barcode ? item.barcode.padStart(14, '0') : `${key(item.brand)}:${key(item.name)}`;
    const previous = unique.get(id);
    if (!previous || score(item) > score(previous)) unique.set(id, item);
  }
  return [...unique.values()].sort((a, b) => score(b) - score(a) || a.name.localeCompare(b.name)).slice(0, 20);
}
/** AI claims require genuine tool provenance and an explicit vegan quote. */
export function parseAIAlternatives(extraction: AIExtraction, raw: AlternativeSearch): VeganAlternative[] {
  const input = validateAlternativeSearch(raw);
  if (!extraction.research?.searched) return [];
  const consulted = new Set(extraction.research.sources.map(source => safeSourceUrl(source.url)));
  const supported = (url: string | undefined) => !!url && url.startsWith('https://') && !!safeSourceUrl(url) && consulted.has(safeSourceUrl(url));
  return (extraction.alternatives ?? []).slice(0, 5).flatMap(item => {
    if (!supported(item.url) || !/\bvegan(?:e[nmrs]?)?\b/i.test(item.quote) || /\b(?:not|non|nicht|kein\w*)[\s-]+vegan(?:e[nmrs]?)?\b/i.test(item.quote)) return [];
    const storeMatch = !!input.store && key(item.store ?? '') === key(input.store) && supported(item.storeUrl) && !!item.storeQuote?.trim();
    return [{ id: item.url, name: item.name, brand: item.brand, url: item.url, source: 'AI', evidence: item.quote,
      storeMatch, stores: storeMatch ? [input.store!] : [], ...(storeMatch ? { storeUrl: item.storeUrl } : {}), marketListed: false }];
  });
}
export async function researchVeganAlternatives(input: AlternativeSearch, provider: ProviderAdapter, signal?: AbortSignal): Promise<VeganAlternative[]> {
  validateAlternativeSearch(input);
  if (!provider.supportsWebSearch) return [];
  const extracted = await provider.extract({ name: input.query, category: input.category, market: input.market, locale: input.locale,
    alternativeSearch: { query: input.query, store: input.store } }, signal);
  return parseAIAlternatives(extracted, input);
}
// Public search endpoints allow 10 searches/minute. Serialize submitted searches and cache briefly.
let queue = Promise.resolve();
let lastStarted = 0;
const cache = new Map<string, { expires: number; document: unknown }>();
export async function searchPublicAlternatives(input: AlternativeSearch, fetcher: typeof fetch = globalThis.fetch, signal?: AbortSignal): Promise<VeganAlternative[]> {
  const items: VeganAlternative[] = [];
  for (const storeOnly of input.store ? [true, false] : [false]) {
    const url = alternativeSearchUrl(input, storeOnly);
    const run = queue.catch(() => {}).then(async () => {
      signal?.throwIfAborted();
      const cached = cache.get(url);
      if (cached && cached.expires > Date.now()) return cached.document;
      const wait = Math.max(0, 6100 - (Date.now() - lastStarted));
      if (wait) await new Promise<void>(resolve => setTimeout(resolve, wait));
      signal?.throwIfAborted(); lastStarted = Date.now();
      const response = await fetcher(url, { credentials: 'omit', redirect: 'error', headers: { Accept: 'application/json' },
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(35000)]) : AbortSignal.timeout(35000) });
      if (!response.ok) throw new Error(`Product search returned HTTP ${response.status}.`);
      const document: unknown = JSON.parse(await readBoundedText(response, 2000000));
      parsePublicAlternatives(document, input);
      if (cache.size >= 20) cache.delete(cache.keys().next().value!);
      cache.set(url, { expires: Date.now() + 300000, document });
      return document;
    });
    queue = run.then(() => {}, () => {});
    try { items.push(...parsePublicAlternatives(await run, input)); }
    catch (error) {
      if (signal?.aborted) throw error;
      if (!storeOnly && !items.length) throw error;
      // A failed store query permits general search; a later failure keeps store matches.
    }
  }
  return rankAlternatives(items, input);
}
