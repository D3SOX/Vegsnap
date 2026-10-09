import { expect, test } from 'bun:test';
import { checkProduct, createOpenAIProvider, selectProductCountry, type AIExtraction } from '../src';
import { OfflineProductIndex, type OfflineSnapshot } from '../src/offline';
import { lookupProduct } from '../src/database';

const automatic = { market: 'DE', autoMarket: true };
test('AI extraction and research use the selected country while preserving the original fallback', async () => {
  const cases = [
    { autoMarket: true, markets: [], packaging: 'Sweden', initial: 'DE', research: 'SE', source: 'packaging' },
    { autoMarket: false, markets: [], packaging: 'Sweden', initial: 'DE', research: 'DE', source: 'manual' },
    { autoMarket: true, markets: ['en:sweden'], initial: 'SE', research: 'SE', source: 'database' },
    { autoMarket: true, markets: ['en:sweden'], packaging: 'Finland', initial: 'SE', research: 'DE', source: 'fallback' },
    { autoMarket: true, markets: ['en:sweden', 'en:norway'], packaging: 'Sweden', initial: 'DE', research: 'SE', source: 'packaging' },
    { autoMarket: true, markets: ['en:sweden', 'en:norway'], packaging: 'Finland', initial: 'DE', research: 'DE', source: 'fallback' },
  ];
  for (const scenario of cases) {
    const requests: { input: { content: { text: string }[] }[] }[] = [];
    const extraction: AIExtraction = { text: '', complete: false, category: 'food', name: 'Example', brand: 'Maker',
      ...(scenario.packaging ? { packaging: { country: scenario.packaging } } : {}) };
    const fetcher = Object.assign(async (_url: string | URL | Request, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)));
      return Response.json({ status: 'completed', output: [
        ...(requests.length === 2 ? [{ type: 'web_search_call', status: 'completed', action: { sources: [] } }] : []),
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify(extraction) }] },
      ] });
    }, { preconnect: fetch.preconnect });
    const catalogueFetcher = Object.assign(async () => new Response('', { status: 404 }), { preconnect: fetch.preconnect });
    const index = new OfflineProductIndex([{ schemaVersion: 1, generatedAt: '2026-10-05T00:00:00Z', region: 'fixture',
      sources: [{ id: 'off', url: 'https://world.openfoodfacts.org', license: 'ODbL-1.0', retrievedAt: '2026-10-05T00:00:00Z' }],
      products: [{ source: 'off', code: '4006381333931', name: 'Example', brands: 'Maker', ingredients: 'unspecified flavouring', countries_tags: scenario.markets, last_modified_t: 1 }],
    }]);
    const input = { market: 'DE', autoMarket: scenario.autoMarket, images: ['data:image/jpeg;base64,AA=='],
      ...(scenario.markets.length ? { barcode: '4006381333931' } : {}) };
    const result = await checkProduct(input, { mode: 'explicit', offlineProducts: index,
      provider: createOpenAIProvider({ baseUrl: 'https://api.openai.com/v1', model: 'fixture', supportsVision: true }, fetcher, catalogueFetcher) });
    expect(requests).toHaveLength(2);
    expect(JSON.parse(requests[0]!.input[0]!.content[0]!.text).market).toBe(scenario.initial);
    const research = JSON.parse(requests[1]!.input[0]!.content[0]!.text);
    expect(research.market).toBe(scenario.research);
    expect(research).not.toHaveProperty('countryContext');
    expect(research).not.toHaveProperty('fallbackMarket');
    expect(result.identity).toMatchObject({ market: scenario.research, marketSource: scenario.source });
    expect(input.market).toBe('DE');
  }
});
test('Open Facts canonical tags select the country and match manual online and offline lookups', async () => {
  for (const [market, tag] of [['CZ', 'czech-republic'], ['TR', 'turkey'], ['HK', 'hong-kong'], ['BA', 'bosnia-and-herzegovina'], ['RE', 'reunion'], ['CI', 'cote-d-ivoire'], ['AX', 'aland-islands'], ['CD', 'democratic-republic-of-the-congo']] as const) {
    const countries_tags = [`en:${tag}`];
    expect(selectProductCountry(automatic, undefined, countries_tags)).toEqual({ market, marketSource: 'database' });
    const product = { code: '4006381333931', product_name: 'Example', ingredients_text: 'water', countries_tags };
    const fetcher = Object.assign(async () => Response.json({ status: 'success', product }), { preconnect: fetch.preconnect });
    expect((await lookupProduct(product.code, { market, autoMarket: false, fetch: fetcher }))?.input.market).toBe(market);
    const offline = new OfflineProductIndex([{ schemaVersion: 1, generatedAt: '2026-10-05T00:00:00Z', region: market, sources: [{ id: 'off', url: 'https://world.openfoodfacts.org', license: 'ODbL-1.0', retrievedAt: '2026-10-05T00:00:00Z' }], products: [{ source: 'off', code: product.code, name: 'Example', brands: '', ingredients: 'water', countries_tags, last_modified_t: 1 }] }]);
    expect(offline.lookup(product.code, { market })?.warnings?.some(warning => warning.startsWith('Different market:'))).toBe(false);
  }
});
test('explicit country clues select a country and conflicting or ambiguous clues use the fallback', () => {
  expect(selectProductCountry(automatic, 'SE')).toEqual({ market: 'SE', marketSource: 'packaging' });
  expect(selectProductCountry(automatic, undefined, ['en:sweden', 'SE'])).toEqual({ market: 'SE', marketSource: 'database' });
  expect(selectProductCountry(automatic, 'Sweden', ['en:germany', 'en:sweden']).market).toBe('SE');
  for (const [packaging, markets] of [[undefined, []], [undefined, ['en:germany', 'en:sweden']], ['constructor', []], ['Swedish', []], ['Made in Sweden', []], ['SE', ['en:germany']], [undefined, ['en:sweden', 'unknown']]] as [string | undefined, string[]][]) {
    expect(selectProductCountry(automatic, packaging, markets)).toEqual({ market: 'DE', marketSource: 'fallback' });
  }
  expect(selectProductCountry({ market: 'FI', autoMarket: false }, 'SE', ['en:sweden'])).toEqual({ market: 'FI', marketSource: 'manual' });
  expect(selectProductCountry({ market: 'NO', autoMarket: true }, undefined, ['en:japan'])).toEqual({ market: 'JP', marketSource: 'database' });
});
test('existing AI extraction can select the packaging country without another request', async () => {
  let calls = 0;
  const result = await checkProduct({ ...automatic, images: ['data:image/jpeg;base64,AA=='] }, {
    mode: 'explicit', provider: { extract: async () => { calls++; return { text: 'Ingredients: water, salt', name: 'Example', category: 'food', complete: true, packaging: { country: 'SE' } }; } },
  });
  expect(calls).toBe(1);
  expect(result.identity.market).toBe('SE');
  expect(result.identity.marketSource).toBe('packaging');
});
test('exact offline barcode country reaches the result but multiple snapshots remain ambiguous', async () => {
  const snapshot = (country: string): OfflineSnapshot => ({ schemaVersion: 1, generatedAt: '2026-10-05T00:00:00Z', region: country, sources: [{ id: 'off', url: 'https://world.openfoodfacts.org', license: 'ODbL-1.0', retrievedAt: '2026-10-05T00:00:00Z' }], products: [{ source: 'off', code: '4006381333931', name: 'Example', brands: '', ingredients: 'water', countries_tags: [country], last_modified_t: 1 }] });
  const input = { ...automatic, barcode: '4006381333931' };
  const single = new OfflineProductIndex([snapshot('en:sweden')]);
  const result = await checkProduct(input, { mode: 'background', offline: true, offlineProducts: single });
  expect(result.identity.market).toBe('SE');
  expect(result.identity.marketSource).toBe('database');
  const ambiguous = new OfflineProductIndex([snapshot('en:sweden'), snapshot('en:germany')]);
  const fallback = await checkProduct(input, { mode: 'background', offline: true, offlineProducts: ambiguous });
  expect(fallback.identity.market).toBe('DE');
  expect(fallback.identity.marketSource).toBe('fallback');
});
test('ambiguous database countries are retained so conflicting packaging uses the fallback', async () => {
  const fetcher = Object.assign(async () => Response.json({ status: 'success', product: { code: '4006381333931', product_name: 'Example', ingredients_text: 'unspecified flavouring', countries_tags: ['en:sweden', 'en:norway'] } }), { preconnect: fetch.preconnect });
  const result = await checkProduct({ ...automatic, barcode: '4006381333931', images: ['data:image/jpeg;base64,AA=='] }, { mode: 'explicit', fetch: fetcher, provider: { extract: async () => ({ text: '', category: 'food', complete: false, packaging: { country: 'FI' } }) } });
  expect(result.identity.market).toBe('DE');
  expect(result.identity.marketSource).toBe('fallback');
  expect(result.warnings.join(' ')).toContain('other markets than DE');
});
test('a manual country retains untagged barcode evidence with an explicit country warning', async () => {
  const fetcher = Object.assign(async () => Response.json({ status: 'success', product: { code: '4006381333931', product_name: 'Example', ingredients_text: 'water' } }), { preconnect: fetch.preconnect });
  const result = await checkProduct({ barcode: '4006381333931', market: 'SE', autoMarket: false }, { mode: 'background', fetch: fetcher });
  expect(result.identity).toMatchObject({ market: 'SE', match: 'exact_barcode' });
  expect(result.evidence.some(item => item.kind === 'database')).toBe(true);
  expect(result.warnings.join(' ')).toContain('does not confirm the product country');
});
test('final warnings use the chosen offline composition while conflicting snapshots remain ambiguous', async () => {
  const pack = (country: string, modified: number): OfflineSnapshot => ({ schemaVersion: 1, generatedAt: '2026-10-05T00:00:00Z', region: country, sources: [{ id: 'off', url: 'https://world.openfoodfacts.org', license: 'ODbL-1.0', retrievedAt: '2026-10-05T00:00:00Z' }], products: [{ source: 'off', code: '4006381333931', name: 'Example', brands: '', ingredients: 'unspecified flavouring', countries_tags: [country], last_modified_t: modified }] });
  const index = new OfflineProductIndex([pack('en:germany', 2), pack('en:sweden', 1)]);
  const result = await checkProduct({ ...automatic, barcode: '4006381333931', images: ['data:image/jpeg;base64,AA=='] }, { mode: 'explicit', offlineProducts: index, provider: { extract: async () => ({ text: '', category: 'food', complete: false, packaging: { country: 'SE' } }) } });
  expect(result.identity).toMatchObject({ market: 'SE', marketSource: 'packaging' });
  expect(result.warnings.join(' ')).toContain('other markets than SE');
});
test('manual countries outside the previous short list still reject another market', async () => {
  const fetcher = Object.assign(async () => Response.json({ status: 'success', product: { code: '4006381333931', countries_tags: ['en:germany'] } }), { preconnect: fetch.preconnect });
  const result = await checkProduct({ market: 'JP', autoMarket: false, barcode: '4006381333931', category: 'food' }, { mode: 'background', fetch: fetcher });
  expect(result.evidence).toEqual([]);
  expect(result.warnings.join(' ')).toContain('does not list JP');
});
