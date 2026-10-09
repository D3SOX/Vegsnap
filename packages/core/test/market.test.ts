import { expect, test } from 'bun:test';
import { checkProduct, selectProductCountry } from '../src';
import { OfflineProductIndex, type OfflineSnapshot } from '../src/offline';

const automatic = { market: 'DE', autoMarket: true };
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
});
test('manual countries outside the previous short list still reject another market', async () => {
  const fetcher = Object.assign(async () => Response.json({ status: 'success', product: { code: '4006381333931', countries_tags: ['en:germany'] } }), { preconnect: fetch.preconnect });
  const result = await checkProduct({ market: 'JP', autoMarket: false, barcode: '4006381333931', category: 'food' }, { mode: 'background', fetch: fetcher });
  expect(result.evidence).toEqual([]);
  expect(result.warnings.join(' ')).toContain('does not list JP');
});
