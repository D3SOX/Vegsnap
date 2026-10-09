import { expect, test } from 'bun:test';
import { checkProduct, OfflineProductIndex, parseOfflineSnapshot, validateOfflineSnapshot, type OfflineSnapshot } from '../src';
const code = '4006381333931';
const snapshot = (): OfflineSnapshot => ({ schemaVersion: 1, generatedAt: '2026-10-05T10:00:00Z', region: 'DE/EU',
  sources: [{ id: 'off', url: 'https://world.openfoodfacts.org', license: 'ODbL-1.0', retrievedAt: '2026-10-05T09:00:00Z' }],
  products: [{ source: 'off', code, name: 'Example', name_de: 'Beispiel', brands: 'Example brand', ingredients: 'milk', ingredients_de: 'Milch', countries_tags: ['en:germany'], last_modified_t: 1760000000 }],
});
test('an offline exact product is evaluated with source date and attribution without network or AI', async () => {
  let requests = 0;
  const result = await checkProduct({ barcode: code, locale: 'de' }, { mode: 'explicit', offline: true, offlineProducts: new OfflineProductIndex([snapshot()]),
    fetch: (async () => { requests++; throw new Error('No network'); }) as unknown as typeof fetch, provider: { extract: async () => { requests++; throw new Error('No AI'); } } });
  expect(requests).toBe(0);
  expect(result.outcome).toBe('not_vegan');
  expect(result.identity).toMatchObject({ match: 'exact_barcode', name: 'Beispiel' });
  expect(result.evidence[0]).toMatchObject({ kind: 'database', license: 'ODbL-1.0 (database); DBCL-1.0 (contents)', retrievedAt: '2026-10-05T09:00:00Z', sourceDate: new Date(1760000000000).toISOString() });
  expect(result.warnings.some(message => message.includes('Teilweiser Offline'))).toBe(true);
});
test('local exact match precedes network databases even when online and preserves partial-list uncertainty', async () => {
  const pack = snapshot(); pack.products[0]!.ingredients = 'water';
  let requests = 0;
  const result = await checkProduct({ barcode: code }, { mode: 'explicit', offlineProducts: new OfflineProductIndex([pack]), fetch: (async () => { requests++; throw new Error('Network must not run'); }) as unknown as typeof fetch });
  expect(requests).toBe(0);
  expect(result.outcome).toBe('uncertain');
  expect(result.basis).toBe('insufficient');
});
test('missing local record falls back online; an offline miss is explicit about partial coverage', async () => {
  const empty = snapshot(); empty.products = [];
  let requests = 0;
  const options = { mode: 'background' as const, offlineProducts: new OfflineProductIndex([empty]), fetch: (async () => { requests++; return new Response('', { status: 404 }); }) as unknown as typeof fetch };
  await checkProduct({ barcode: code }, options);
  expect(requests).toBe(3);
  const offline = await checkProduct({ barcode: code }, { ...options, offline: true });
  expect(requests).toBe(3);
  expect(offline.warnings).toContain('No exact record in the partial offline database.');
});
test('snapshot matching respects GTIN equivalence, market and newest product modification', () => {
  const old = snapshot(); const fresh = snapshot(); fresh.region = 'Extra'; fresh.products[0]!.name = 'Updated'; fresh.products[0]!.last_modified_t++;
  const index = new OfflineProductIndex([old, fresh]);
  expect(index.lookup(code.padStart(14, '0'))?.input.name).toBe('Updated');
  expect(index.lookup(code, { market: 'SE' })?.warnings?.some(message => message.startsWith('Different market:'))).toBe(true);
  expect(() => index.lookup('4006381333932')).toThrow('GTIN');
});
test('manual offline countries exclude tagged mismatches and prefer matching composition over freshness', async () => {
  const german = snapshot(); german.products[0]!.ingredients = 'milk';
  const swedish = snapshot(); swedish.products[0]!.countries_tags = ['en:sweden']; swedish.products[0]!.ingredients = 'water'; swedish.products[0]!.last_modified_t--;
  const index = new OfflineProductIndex([german, swedish]);
  expect(index.lookup(code, { market: 'JP', autoMarket: false })).toBeNull();
  for (const autoMarket of [false, true]) {
    const result = await checkProduct({ barcode: code, market: 'SE', autoMarket }, { mode: 'background', offline: true, offlineProducts: index });
    expect(result.identity).toMatchObject({ market: 'SE', marketSource: autoMarket ? 'fallback' : 'manual' });
    expect(result.outcome).toBe('uncertain');
    expect(result.evidence.find(item => item.kind === 'database')?.excerpt).toBe('water');
  }
  const untagged = snapshot(); untagged.products[0]!.countries_tags = [];
  expect(new OfflineProductIndex([untagged]).lookup(code, { market: 'JP', autoMarket: false })?.input.text).toBe('milk');
});
test('offline country clues and composition come only from category-eligible barcode records', async () => {
  const pack = snapshot();
  pack.sources.push(
    { id: 'obf', url: 'https://world.openbeautyfacts.org', license: 'ODbL-1.0', retrievedAt: pack.generatedAt },
    { id: 'opf', url: 'https://world.openproductsfacts.org', license: 'ODbL-1.0', retrievedAt: pack.generatedAt },
  );
  const food = pack.products[0]!;
  food.countries_tags = ['en:sweden']; food.ingredients = 'water';
  pack.products.push(
    { ...food, source: 'obf', countries_tags: ['en:finland'], ingredients: 'milk' },
    { ...food, source: 'opf', countries_tags: ['en:germany'], ingredients: 'wool' },
  );
  const index = new OfflineProductIndex([pack]);
  for (const [category, market, source] of [['food', 'SE', 'off'], ['drink', 'SE', 'off'], ['cosmetics', 'FI', 'obf'], ['clothing', 'DE', 'opf'], ['shoes', 'DE', 'opf'], ['household', 'DE', 'opf']] as const) {
    const record = index.lookup(code, { category, market: 'NO', autoMarket: true });
    expect(record?.input.market).toBe(market);
    expect(record?.markets).toEqual(record?.evidenceMarkets);
    expect(record?.evidence.id).toBe(`offline:${source}:${code}`);
  }
  expect(index.lookup(code, { category: 'other', market: 'NO', autoMarket: true })?.input.market).toBe('NO');
  const result = await checkProduct({ barcode: code, category: 'food', market: 'DE', autoMarket: true }, { mode: 'background', offline: true, offlineProducts: index });
  expect(result.identity).toMatchObject({ market: 'SE', marketSource: 'database' });
  expect(result.outcome).toBe('uncertain');
  const onlyFood = new OfflineProductIndex([snapshot()]);
  expect(onlyFood.lookup(code, { category: 'cosmetics', autoMarket: true })).toBeNull();
});
test('invalid identifiers, duplicates, untrusted fields and source metadata cannot enter a pack', () => {
  for (const mutate of [
    (pack: OfflineSnapshot) => { pack.products[0]!.code = '4006381333932'; },
    (pack: OfflineSnapshot) => { pack.products.push({ ...pack.products[0]!, code: code.padStart(14, '0') }); },
    (pack: OfflineSnapshot) => { pack.sources[0]!.url = 'https://fake.example'; },
    (pack: OfflineSnapshot) => { pack.generatedAt = 'not a date'; },
    (pack: OfflineSnapshot) => { pack.products[0]!.ingredients = 'x'.repeat(12001); },
  ]) { const pack = snapshot(); mutate(pack); expect(() => validateOfflineSnapshot(pack)).toThrow(); }
  const pack = snapshot();
  expect(() => parseOfflineSnapshot(JSON.stringify({ ...pack, products: [{ ...pack.products[0], certified: true }] }))).toThrow();
});
