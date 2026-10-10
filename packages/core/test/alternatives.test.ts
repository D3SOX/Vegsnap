import { describe, expect, spyOn, test } from 'bun:test';
import fixtures from '../../../contracts/alternatives-fixtures.json';
import { alternativeQueryForProduct, alternativeSearchUrl, parsePublicAlternatives, parseAIAlternatives, rankAlternatives, researchVeganAlternatives, searchPublicAlternatives, validateAlternativeSearch } from '../src/alternatives';
import type { AlternativeSearch } from '../src/alternatives';
import type { AIExtraction } from '../src/types';
import { createOpenAIProvider, validateAIExtraction } from '../src/provider';

const input = fixtures.input as AlternativeSearch;
describe('vegan alternatives', () => {
  test('prefills a substitute-friendly query without erasing a product named only for its animal ingredient', () => {
    expect(alternativeQueryForProduct('Maker Honey granola', 'Maker', ['honey'])).toBe('granola');
    expect(alternativeQueryForProduct('Milk chocolate', '', ['milk'])).toBe('chocolate');
    expect(alternativeQueryForProduct('Milk', '', ['milk'])).toBe('Milk');
  });
  test('public search falls back after a store outage and preserves store matches after a general outage', async () => {
    let clock = Date.now(), requests = 0;
    const time = spyOn(Date, 'now').mockImplementation(() => clock += 7000);
    try {
      const fetcher = (failStore: boolean) => Object.assign(async (url: string | URL | Request) => {
        requests++;
        const storeOnly = new URL(String(url)).searchParams.has('tag_1');
        return storeOnly === failStore ? new Response('', { status: 503 }) : Response.json(fixtures.document);
      }, { preconnect: globalThis.fetch.preconnect });
      expect(await searchPublicAlternatives({ ...input, query: 'store-outage' }, fetcher(true))).toHaveLength(3);
      expect(await searchPublicAlternatives({ ...input, query: 'general-outage' }, fetcher(false))).toHaveLength(3);
      expect(requests).toBe(4);
      const controller = new AbortController(); controller.abort();
      await expect(searchPublicAlternatives(input, fetcher(false), controller.signal)).rejects.toThrow();
      expect(requests).toBe(4);
    } finally { time.mockRestore(); }
  });
  test('ranks exact store records ahead of general matches and rejects unsafe candidates', () => {
    const items = parsePublicAlternatives(fixtures.document, input);
    expect(items.map(item => item.barcode)).toEqual(fixtures.expectedCodes);
    expect(items[0]?.storeMatch).toBe(true);
    const taggedOnly = { products: [{ ...fixtures.document.products[0]!, stores: '', stores_tags: ['rewe'] }] };
    expect(parsePublicAlternatives(taggedOnly, input).find(item => item.barcode === taggedOnly.products[0]!.code)?.stores).toEqual(['REWE']);
    expect(items[2]?.storeMatch).toBe(false); // REWE City is not the requested store.
    expect(items[2]?.marketListed).toBe(false);
    expect(parsePublicAlternatives(fixtures.document, { ...input, store: '' }).every(item => !item.storeMatch)).toBe(true);
  });
  test('uses full text search plus vegan and optional store filters across categories', () => {
    const url = new URL(alternativeSearchUrl({ ...input, query: 'chocolate & nuts', store: 'A&B' }, true));
    expect(url.pathname).toBe('/cgi/search.pl');
    expect(url.searchParams.get('search_terms')).toBe('chocolate & nuts');
    expect(url.searchParams.get('tag_0')).toBe('vegan');
    expect(url.searchParams.get('tag_1')).toBe('A&B');
    expect(new URL(alternativeSearchUrl(input)).searchParams.has('tag_1')).toBe(false);
    expect(new URL(alternativeSearchUrl({ ...input, category: 'cosmetics' })).hostname).toContain('openbeautyfacts');
    expect(new URL(alternativeSearchUrl({ ...input, category: 'shoes' })).hostname).toContain('openproductsfacts');
    expect(() => validateAlternativeSearch({ ...input, query: 'x' })).toThrow();
    expect(() => validateAlternativeSearch({ ...input, market: 'EU' })).toThrow();
    expect(() => parsePublicAlternatives({ products: [], error: 'unavailable' }, input)).toThrow();
  });
  const extraction: AIExtraction = { text: '', complete: false, category: 'food', alternatives: [
    { name: 'Vegan chocolate', brand: 'Plant', quote: 'This chocolate is vegan.', url: 'https://maker.example/chocolate',
      store: 'REWE', storeUrl: 'https://store.example/chocolate', storeQuote: 'Plant vegan chocolate available at REWE' },
  ], research: { searched: true, sources: [{ url: 'https://maker.example/chocolate', title: 'Maker' }, { url: 'https://store.example/chocolate', title: 'Store' }] } };
  test('requires tool provenance, vegan support, and separately sourced store listing', () => {
    expect(parseAIAlternatives(extraction, input)[0]?.storeMatch).toBe(true);
    expect(parseAIAlternatives({ ...extraction, research: undefined }, input)).toEqual([]);
    expect(parseAIAlternatives({ ...extraction, research: { searched: true, sources: [] } }, input)).toEqual([]);
    expect(parseAIAlternatives({ ...extraction, research: { searched: true, sources: extraction.research!.sources.slice(0, 1) } }, input)[0]?.storeMatch).toBe(false);
    for (const quote of ['Not vegan.', 'Nicht vegane Schokolade.', 'Kein veganer Ersatz.']) expect(parseAIAlternatives({ ...extraction, alternatives: [{ ...extraction.alternatives![0]!, quote }] }, input)).toEqual([]);
    expect(parseAIAlternatives({ ...extraction, alternatives: [{ ...extraction.alternatives![0]!, quote: 'Vegane Schokolade mit Haferdrink.' }] }, input)).toHaveLength(1);
    expect(parseAIAlternatives({ ...extraction, alternatives: [{ ...extraction.alternatives![0]!, quote: 'Plant-based chocolate.' }] }, input)).toEqual([]);
    const { research: _research, ...modelExtraction } = extraction;
    expect(() => validateAIExtraction(modelExtraction)).not.toThrow();
    expect(() => validateAIExtraction({ ...extraction, research: undefined, alternatives: [{ name: 42 }] })).toThrow();
  });
  test('research sends only public query, retailer, category and country; unsupported providers are skipped', async () => {
    let called = false;
    expect(await researchVeganAlternatives(input, { supportsWebSearch: false, async extract() { called = true; return extraction; } })).toEqual([]);
    expect(called).toBe(false);
    const items = await researchVeganAlternatives(input, { supportsWebSearch: true, async extract(value) {
      expect(value).toEqual({ name: input.query, category: input.category, market: input.market, locale: input.locale, alternativeSearch: { query: input.query, store: input.store } });
      return extraction;
    } });
    expect(items).toHaveLength(1);
    expect(rankAlternatives([...items, ...items], input)).toHaveLength(1);
  });
  test('OpenAI forces searched alternatives without an exact-product follow-up', async () => {
    let calls = 0;
    const fetcher = Object.assign(async (_url: string | URL | Request, init?: RequestInit) => {
      calls++; const body = JSON.parse(String(init?.body));
      expect(body.tool_choice).toBe('required');
      expect(JSON.parse(body.input[0].content[0].text).alternativeSearch.query).toBe(input.query);
      const { research: _, ...model } = extraction;
      return Response.json({ status: 'completed', output: [
        { type: 'web_search_call', status: 'completed', action: { sources: extraction.research!.sources } },
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify(model) }] },
      ] });
    }, { preconnect: globalThis.fetch.preconnect });
    expect(await researchVeganAlternatives(input, createOpenAIProvider({ baseUrl: 'https://api.openai.com/v1', model: 'test' }, fetcher))).toHaveLength(1);
    expect(calls).toBe(1);
  });
});
