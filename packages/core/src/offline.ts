import { resultMessages } from './i18n';
import { DATABASES, normalizeBarcode } from './database';
import type { CheckInput, DatabaseProduct } from './types';
import { countryCode, selectProductCountry } from './market';

export const OFFLINE_MAX_BYTES = 10_000_000;
export interface OfflineSnapshot {
  schemaVersion: 1;
  generatedAt: string;
  region: string;
  sources: { id: 'off' | 'obf' | 'opf'; url: string; license: string; retrievedAt: string }[];
  products: {
    source: 'off' | 'obf' | 'opf'; code: string; name: string; name_de?: string; name_en?: string;
    brands: string; ingredients: string; ingredients_de?: string; ingredients_en?: string;
    countries_tags: string[]; last_modified_t: number;
  }[];
}
export interface OfflinePackInfo { region: string; generatedAt: string; count: number; bundled: boolean; }
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function string(value: unknown, max: number): value is string { return typeof value === 'string' && value.length <= max; }
function timestamp(value: unknown): value is string { return typeof value === 'string' && value.length <= 40 && /^\d{4}-\d\d-\d\dT/.test(value) && Number.isFinite(Date.parse(value)); }
function only(value: Record<string, unknown>, keys: string[]): boolean { return Object.keys(value).every(key => keys.includes(key)); }

/** Imported snapshots are data only: no arbitrary URLs, labels, or completeness claims can influence a verdict. */
export function validateOfflineSnapshot(value: unknown): OfflineSnapshot {
  if (!record(value) || !only(value, ['schemaVersion', 'generatedAt', 'region', 'sources', 'products']) || value.schemaVersion !== 1 ||
    !timestamp(value.generatedAt) || !string(value.region, 80) || !value.region.trim() ||
    !Array.isArray(value.sources) || !value.sources.length || value.sources.length > 3 ||
    !Array.isArray(value.products) || value.products.length > 10_000) throw new Error('Invalid offline pack format.');
  if (new TextEncoder().encode(JSON.stringify(value)).length > OFFLINE_MAX_BYTES) throw new Error('Offline packs must be no larger than 10 MB.');
  const sourceIds = new Set<string>();
  for (const source of value.sources) {
    if (!record(source) || !only(source, ['id', 'url', 'license', 'retrievedAt']) ||
      !string(source.id, 3) || sourceIds.has(source.id) || !DATABASES.some(db => db.id === source.id && db.origin === source.url) ||
      !string(source.license, 200) || !source.license.includes('ODbL-1.0') || !timestamp(source.retrievedAt)) throw new Error('Invalid offline pack source attribution.');
    sourceIds.add(source.id);
  }
  const products = new Set<string>();
  for (const product of value.products) {
    if (!record(product) || !only(product, ['source', 'code', 'name', 'name_de', 'name_en', 'brands', 'ingredients', 'ingredients_de', 'ingredients_en', 'countries_tags', 'last_modified_t']) ||
      typeof product.source !== 'string' || !sourceIds.has(product.source) || typeof product.code !== 'string' || !/^\d+$/.test(product.code) || !normalizeBarcode(product.code) ||
      !string(product.name, 500) || !string(product.brands, 500) || !string(product.ingredients, 12_000) ||
      ['name_de', 'name_en'].some(key => product[key] !== undefined && !string(product[key], 500)) ||
      ['ingredients_de', 'ingredients_en'].some(key => product[key] !== undefined && !string(product[key], 12_000)) ||
      !Array.isArray(product.countries_tags) || product.countries_tags.length > 64 || product.countries_tags.some(tag => !string(tag, 80)) ||
      typeof product.last_modified_t !== 'number' || !Number.isSafeInteger(product.last_modified_t) || product.last_modified_t < 0 || !Number.isFinite(new Date(product.last_modified_t * 1000).getTime())) throw new Error('Invalid product in offline pack.');
    const key = `${product.source}:${product.code.padStart(14, '0')}`;
    if (products.has(key)) throw new Error('Offline pack contains a duplicate product identifier.');
    products.add(key);
  }
  return value as unknown as OfflineSnapshot;
}
export function parseOfflineSnapshot(text: string): OfflineSnapshot {
  if (text.length > OFFLINE_MAX_BYTES || new TextEncoder().encode(text).length > OFFLINE_MAX_BYTES) throw new Error('Offline packs must be no larger than 10 MB.');
  return validateOfflineSnapshot(JSON.parse(text));
}
type OfflineEntry = { product: OfflineSnapshot['products'][number]; snapshot: OfflineSnapshot };
function rankEntries(entries: readonly OfflineEntry[], input: Pick<CheckInput, 'category' | 'market'>): OfflineEntry[] {
  const market = input.market ?? 'DE';
  const preferred = input.category === 'cosmetics' ? 'obf' : ['clothing', 'shoes', 'household'].includes(input.category ?? '') ? 'opf' : 'off';
  const matchesMarket = (product: OfflineSnapshot['products'][number]) => product.countries_tags.some(tag => countryCode(tag) === market);
  return [...entries].sort((a, b) => Number(matchesMarket(b.product)) - Number(matchesMarket(a.product)) || Number(b.product.source === preferred) - Number(a.product.source === preferred) || b.product.last_modified_t - a.product.last_modified_t || Date.parse(b.snapshot.generatedAt) - Date.parse(a.snapshot.generatedAt));
}
export class OfflineProductIndex {
  private readonly products = new Map<string, OfflineEntry[]>();
  constructor(snapshots: readonly OfflineSnapshot[]) {
    for (const raw of snapshots) {
      const snapshot = validateOfflineSnapshot(raw);
      for (const product of snapshot.products) {
        const key = product.code.padStart(14, '0');
        const entries = this.products.get(key) ?? [];
        entries.push({ product, snapshot });
        this.products.set(key, entries);
      }
    }
  }
  search(source: OfflineSnapshot['products'][number]['source'], query: string, offset = 0, market = 'DE') {
    const matches = [...this.products.values()].flatMap(entries => {
      const entry = rankEntries(entries.filter(item => item.product.source === source), { market })[0];
      if (!entry || !`${entry.product.name} ${entry.product.name_de ?? ''} ${entry.product.name_en ?? ''} ${entry.product.brands} ${entry.product.code}`.toLowerCase().includes(query.toLowerCase())) return [];
      return [{ ...entry.product, snapshotDate: entry.snapshot.generatedAt }];
    });
    return matches.slice(offset, offset + 20);
  }
  lookup(barcode: string, input: Pick<CheckInput, 'category' | 'locale' | 'market' | 'autoMarket'> = {}): DatabaseProduct | null {
    const t = resultMessages[input.locale ?? 'en'];
    const code = normalizeBarcode(barcode);
    if (!code) throw new Error('Invalid GTIN/EAN: check the digits and checksum.');
    const allowed = input.category === 'food' || input.category === 'drink' ? ['off'] : input.category === 'cosmetics' ? ['obf'] : ['clothing', 'shoes', 'household'].includes(input.category ?? '') ? ['opf'] : DATABASES.map(db => db.id);
    const entries = (this.products.get(code.padStart(14, '0')) ?? []).filter(entry => allowed.includes(entry.product.source));
    const countryTags = [...new Set(entries.flatMap(entry=>entry.product.countries_tags))];
    const market = selectProductCountry(input,undefined,countryTags).market;
    const matchesMarket = (product: OfflineSnapshot['products'][number]) => product.countries_tags.some(tag => countryCode(tag) === market);
    const eligible = !input.autoMarket ? entries.filter(({ product }) => !product.countries_tags.length || matchesMarket(product)) : entries;
    const entry = rankEntries(eligible, {...input,market})[0];
    if (!entry) return null;
    const { product, snapshot } = entry;
    const db = DATABASES.find(item => item.id === product.source)!;
    const source = snapshot.sources.find(item => item.id === product.source)!;
    const text = (input.locale === 'de' ? product.ingredients_de : product.ingredients_en) || product.ingredients || product.ingredients_de || product.ingredients_en || '';
    const name = (input.locale === 'de' ? product.name_de : product.name_en) || product.name || product.name_de || product.name_en || '';
    return {
      markets: countryTags,
      evidenceMarkets: product.countries_tags,
      input: { barcode: code, name, brand: product.brands, text, complete: false, locale: input.locale, market,
        category: input.category && input.category !== 'other' ? input.category : db.category, sourceUrl: `${db.origin}/product/${product.code}` },
      evidence: { id: `offline:${db.id}:${product.code}`, kind: 'database', title: `${db.name} — ${t.offlineSnapshot} (${snapshot.region})`,
        excerpt: text || name || code, url: `${db.origin}/product/${product.code}`, retrievedAt: source.retrievedAt,
        sourceDate: new Date(product.last_modified_t * 1000).toISOString(), license: `${source.license} (database); DBCL-1.0 (contents)` },
      labels: [],
      warnings: [t.offlineSnapshotCoverage.replace('{date}', snapshot.generatedAt.slice(0, 10)),
        ...(product.countries_tags.length && !matchesMarket(product) ? [t.offlineMarketMismatch.replace('{markets}', product.countries_tags.join(', ')).replace('{market}', market)] : []),
      ],
    };
  }
}
