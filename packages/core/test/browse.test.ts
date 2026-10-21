import { describe, expect, spyOn, test } from 'bun:test';
import { browseCheckInput, browseOfflinePage, browseSearchUrl, parseBrowsePage, searchBrowse, validateBrowseSearch, type BrowseSearch } from '../src/browse';
import { searchPublicAlternatives } from '../src/alternatives';
import { OfflineProductIndex, type OfflineSnapshot } from '../src/offline';
import { PublicSearchError } from '../src/public-search';

const input: BrowseSearch = { source: 'off', query: ' oat drink ', locale: 'de' };
const document = { count: 45, products: [
  { code: '4006381333931', product_name: 'Oat drink', product_name_de: 'Haferdrink', brands: 'Plant', ingredients_text: 'water, oats', ingredients_text_de: 'Wasser, Hafer',
    countries: 'Germany, Austria', countries_tags: ['en:germany', 'en:austria'], quantity: '1 l', labels: 'Vegan', last_modified_t: 1760000000 },
  { code: '4006381333931', product_name: 'Duplicate code', brands: 'Other' },
  { code: 'abc', product_name: 'Invalid code' },
  { code: '12345', product_name: '', brands: '', countries_tags: ['en:sweden'], last_modified_t: -5 },
  'not an object',
] };
const pack: OfflineSnapshot = { schemaVersion: 1, generatedAt: '2026-10-05T10:00:00Z', region: 'Sweden',
  sources: [{ id: 'off', url: 'https://world.openfoodfacts.org', license: 'ODbL-1.0', retrievedAt: '2026-10-05T09:00:00Z' }],
  products: [
    { source: 'off', code: '4006381333931', name: 'Oat drink', name_de: 'Haferdrink', brands: 'Plant', ingredients: 'water, oats', ingredients_de: 'Wasser, Hafer', countries_tags: ['en:sweden'], last_modified_t: 1760000000 },
    { source: 'off', code: '7310865004703', name: 'Soy drink', brands: 'Plant', ingredients: 'water, soy', countries_tags: ['en:sweden'], last_modified_t: 0 },
  ] };

describe('database browsing', () => {
  test('accepts only submitted searches of 2–200 characters against a known database', () => {
    expect(validateBrowseSearch(input)).toEqual({ source: 'off', query: 'oat drink', cursor: 0, locale: 'de' });
    expect(() => validateBrowseSearch({ ...input, query: 'x' })).toThrow();
    expect(() => validateBrowseSearch({ ...input, query: 'x'.repeat(201) })).toThrow();
    expect(() => validateBrowseSearch({ ...input, source: 'wikidata' })).toThrow();
    expect(() => validateBrowseSearch({ ...input, cursor: -1 })).toThrow();
    expect(() => validateBrowseSearch({ ...input, cursor: 1.5 })).toThrow();
    expect(() => validateBrowseSearch({ ...input, locale: 'fr' })).toThrow();
  });
  test('requests one localized page of twenty records without search-as-you-type parameters', () => {
    const url = new URL(browseSearchUrl({ ...input, source: 'obf', cursor: 2 }));
    expect(url.origin).toBe('https://world.openbeautyfacts.org');
    expect(url.pathname).toBe('/cgi/search.pl');
    expect(url.searchParams.get('search_terms')).toBe('oat drink');
    expect(url.searchParams.get('page')).toBe('3');
    expect(url.searchParams.get('page_size')).toBe('20');
    expect(url.searchParams.get('lc')).toBe('de');
    expect(url.searchParams.get('fields')).toContain('product_name_de');
    expect(url.searchParams.get('fields')).toContain('ingredients_text_de');
  });
  test('parses localized records, drops invalid and duplicate codes, and pages by the reported count', () => {
    const page = parseBrowsePage(document, input);
    expect(page.offline).toBe(false);
    expect(page.records.map(record => record.id)).toEqual(['4006381333931', '12345']);
    expect(page.records[0]).toEqual({ id: '4006381333931', source: 'off', name: 'Haferdrink', barcode: '4006381333931', brand: 'Plant', composition: 'Wasser, Hafer',
      markets: 'Germany, Austria', countryTags: ['en:germany', 'en:austria'], quantity: '1 l', labels: 'Vegan', updated: '2025-10-09', url: 'https://world.openfoodfacts.org/product/4006381333931' });
    expect(page.records[1]).toMatchObject({ name: '12345', barcode: '', markets: 'sweden', updated: '' });
    expect(page.next).toBe(1);
    expect(parseBrowsePage(document, { ...input, cursor: 1 }).next).toBe(2);
    expect(parseBrowsePage(document, { ...input, cursor: 2 }).next).toBeUndefined();
    expect(parseBrowsePage({ products: [] }, input)).toEqual({ records: [], offline: false });
    expect(parseBrowsePage({ products: Array.from({ length: 20 }, (_, i) => ({ code: String(10000 + i), product_name: 'Item' })) }, { ...input, cursor: 99 }).next).toBeUndefined();
    expect(() => parseBrowsePage({ products: [], error: 'unavailable' }, input)).toThrow(PublicSearchError);
    expect(() => parseBrowsePage({ result: [] }, input)).toThrow(PublicSearchError);
  });
  test('offline packs answer the same search with snapshot dates and localized names', () => {
    const index = new OfflineProductIndex([pack]);
    const page = browseOfflinePage(index, input, 'SE');
    expect(page.offline).toBe(true);
    expect(page.next).toBeUndefined();
    expect(page.records).toEqual([{ id: '4006381333931', source: 'off', name: 'Haferdrink', barcode: '4006381333931', brand: 'Plant', composition: 'Wasser, Hafer', markets: 'sweden',
      countryTags: ['en:sweden'], quantity: '', labels: '', updated: '2025-10-09', url: 'https://world.openfoodfacts.org/product/4006381333931', snapshotDate: '2026-10-05T10:00:00Z' }]);
    expect(browseOfflinePage(index, { source: 'off', query: 'drink plant' }, 'SE').records.map(record => record.name)).toEqual(['Oat drink', 'Soy drink']);
    expect(browseOfflinePage(index, { source: 'off', query: 'drink nothing' }, 'SE').records).toEqual([]);
    expect(browseOfflinePage(index, { source: 'obf', query: 'oat drink' }, 'SE').records).toEqual([]);
    expect(browseOfflinePage(index, { source: 'off', query: 'oat drink', cursor: 1 }, 'SE').records).toEqual([]);
  });
  test('a selected record becomes an editable draft, never a complete label', () => {
    const record = parseBrowsePage(document, input).records[0]!;
    expect(browseCheckInput(record)).toEqual({ text: 'Wasser, Hafer', name: 'Haferdrink', brand: 'Plant', barcode: '4006381333931', category: 'food', complete: false });
    expect(browseCheckInput({ ...record, source: 'obf', barcode: '', brand: '' })).toEqual({ text: 'Wasser, Hafer', name: 'Haferdrink', category: 'cosmetics', complete: false });
  });
  test('submitted searches classify failures and share one paced cache with alternative searches', async () => {
    let clock = Date.now(), requests = 0, status = 200, networkFailure = false;
    const time = spyOn(Date, 'now').mockImplementation(() => clock += 7000);
    const fetcher = Object.assign(async () => {
      requests++;
      if (networkFailure) throw new TypeError('fetch failed');
      return status === 200 ? Response.json(document) : new Response('', { status });
    }, { preconnect: globalThis.fetch.preconnect });
    try {
      const query = { ...input, query: `browse ${clock}` };
      expect((await searchBrowse(query, fetcher)).records).toHaveLength(2);
      expect((await searchBrowse(query, fetcher)).records).toHaveLength(2);
      expect(requests).toBe(1);
      for (const [code, reason] of [[429, 'rate_limited'], [503, 'temporarily_unavailable'], [504, 'timeout'], [403, 'unavailable']] as const) {
        status = code;
        const failure = await searchBrowse({ ...query, cursor: code }, fetcher).catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(PublicSearchError);
        expect((failure as PublicSearchError).reason).toBe(reason);
      }
      status = 200; networkFailure = true;
      const offline = await searchBrowse({ ...query, cursor: 1 }, fetcher).catch((error: unknown) => error);
      expect((offline as PublicSearchError).reason).toBe('connection');
      networkFailure = false;
      const controller = new AbortController(); controller.abort();
      await expect(searchBrowse({ ...query, cursor: 2 }, fetcher, controller.signal)).rejects.toThrow();
      const before = requests;
      // The alternatives search rejects an outage with the same classified error.
      status = 503;
      const alternatives = await searchPublicAlternatives({ query: `alternatives ${clock}`, category: 'food', market: 'DE' }, fetcher).catch((error: unknown) => error);
      expect((alternatives as PublicSearchError).reason).toBe('temporarily_unavailable');
      expect(requests).toBe(before + 1);
    } finally { time.mockRestore(); }
  });
});
