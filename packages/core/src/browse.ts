import type { CheckInput, Locale } from './types';
import { DATABASES } from './database';
import { locales } from './locale';
import { normalizeBarcode } from './barcode';
import type { OfflineProductIndex } from './offline';
import { fetchPublicSearch, PublicSearchError } from './public-search';

export type BrowseSource = typeof DATABASES[number]['id'];
export interface BrowseSearch { source: BrowseSource; query: string; cursor?: number; locale?: Locale; }
export interface BrowseRecord {
  id: string; source: BrowseSource; name: string; barcode: string; brand: string; composition: string;
  markets: string; countryTags: string[]; quantity: string; labels: string; updated: string; url: string; snapshotDate?: string;
}
export interface BrowsePage { records: BrowseRecord[]; next?: number; offline: boolean; }
export const BROWSE_PAGE_SIZE = 20;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, maximum: number) => typeof value === 'string' ? value.trim().slice(0, maximum) : '';
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
const isoDate = (seconds: number) => { try { return new Date(seconds * 1000).toISOString().slice(0, 10); } catch { return ''; } };
const marketNames = (tags: string[]) => tags.map(tag => tag.slice(tag.indexOf(':') + 1).replaceAll('-', ' ')).join(', ');
const database = (source: BrowseSource) => DATABASES.find(db => db.id === source)!;

/** Submitted searches only: 2–200 characters against one public database. */
export function validateBrowseSearch(input: unknown): Required<BrowseSearch> {
  if (!object(input) || !DATABASES.some(db => db.id === input.source) || typeof input.query !== 'string' || input.query.trim().length < 2 || input.query.length > 200 ||
    input.cursor !== undefined && (!Number.isInteger(input.cursor) || (input.cursor as number) < 0 || (input.cursor as number) > 10_000) ||
    input.locale !== undefined && !locales.includes(input.locale as Locale)) throw new Error('Invalid database search.');
  return { source: input.source as BrowseSource, query: input.query.trim(), cursor: (input.cursor as number | undefined) ?? 0, locale: (input.locale as Locale | undefined) ?? 'en' };
}
export function browseSearchUrl(raw: BrowseSearch): string {
  const input = validateBrowseSearch(raw);
  const url = new URL('/cgi/search.pl', database(input.source).origin);
  const params = { search_terms: input.query, search_simple: '1', action: 'process', json: '1', page: String(input.cursor + 1), page_size: String(BROWSE_PAGE_SIZE),
    fields: `code,product_name,product_name_${input.locale},brands,ingredients_text,ingredients_text_${input.locale},countries,countries_tags,quantity,labels,last_modified_t`, lc: input.locale };
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
  return url.href;
}
/** Community records are drafts: never a complete label, a certification, or a vegan verdict. */
export function parseBrowsePage(document: unknown, raw: BrowseSearch): BrowsePage {
  const input = validateBrowseSearch(raw), db = database(input.source);
  if (!object(document) || !Array.isArray(document.products) || document.error || document.errors) throw new PublicSearchError('unavailable', 'Invalid product search response.');
  const records = new Map<string, BrowseRecord>();
  for (const product of document.products.slice(0, BROWSE_PAGE_SIZE)) {
    if (!object(product)) continue;
    const code = text(product.code, 30);
    if (!/^[0-9]{4,30}$/.test(code) || records.has(code)) continue;
    const countryTags = strings(product.countries_tags).slice(0, 30).map(tag => tag.slice(0, 100).trim()).filter(Boolean);
    const changed = typeof product.last_modified_t === 'number' && product.last_modified_t > 0 ? product.last_modified_t : 0;
    records.set(code, {
      id: code, source: db.id, name: text(product[`product_name_${input.locale}`], 300) || text(product.product_name, 300) || code,
      barcode: normalizeBarcode(code) ? code : '', brand: text(product.brands, 300),
      composition: text(product[`ingredients_text_${input.locale}`], 20_000) || text(product.ingredients_text, 20_000),
      markets: text(product.countries, 1000) || marketNames(countryTags), countryTags,
      quantity: text(product.quantity, 100), labels: text(product.labels, 1000), updated: changed ? isoDate(changed) : '',
      url: `${db.origin}/product/${code}`,
    });
  }
  const count = typeof document.count === 'number' && Number.isFinite(document.count) ? document.count : -1;
  const more = count >= 0 ? (input.cursor + 1) * BROWSE_PAGE_SIZE < count : document.products.length >= BROWSE_PAGE_SIZE;
  return { records: [...records.values()], ...(more && input.cursor < 99 ? { next: input.cursor + 1 } : {}), offline: false };
}
/** The bundled and imported packs answer the same search while online databases are unreachable. */
export function browseOfflinePage(index: Pick<OfflineProductIndex, 'search'>, raw: BrowseSearch, market = 'DE'): BrowsePage {
  const input = validateBrowseSearch(raw), db = database(input.source);
  const localized = (base: string, german?: string, english?: string) => (input.locale === 'de' ? german : english) || base || german || english || '';
  const records = index.search(input.source, input.query, input.cursor * BROWSE_PAGE_SIZE, market).map((product): BrowseRecord => ({
    id: product.code, source: db.id, name: localized(product.name, product.name_de, product.name_en) || product.code, barcode: product.code, brand: product.brands,
    composition: localized(product.ingredients, product.ingredients_de, product.ingredients_en), markets: marketNames(product.countries_tags), countryTags: product.countries_tags,
    quantity: '', labels: '', updated: product.last_modified_t > 0 ? isoDate(product.last_modified_t) : '', url: `${db.origin}/product/${product.code}`, snapshotDate: product.snapshotDate,
  }));
  return { records, ...(records.length === BROWSE_PAGE_SIZE ? { next: input.cursor + 1 } : {}), offline: true };
}
export async function searchBrowse(raw: BrowseSearch, fetcher: typeof fetch = globalThis.fetch, signal?: AbortSignal): Promise<BrowsePage> {
  const input = validateBrowseSearch(raw);
  return parseBrowsePage(await fetchPublicSearch(browseSearchUrl(input), fetcher, signal, document => parseBrowsePage(document, input)), input);
}
/** A selected record starts a check as an editable draft; it never counts as a complete label. */
export function browseCheckInput(record: BrowseRecord): CheckInput {
  return { text: record.composition, name: record.name, ...(record.brand ? { brand: record.brand } : {}), ...(record.barcode ? { barcode: record.barcode } : {}),
    category: database(record.source).category, complete: false };
}
