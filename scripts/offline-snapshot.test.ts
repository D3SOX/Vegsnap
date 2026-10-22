import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CACHE_TTL_MS, createSnapshot, normalizeProduct, refreshSnapshot, refreshSnapshots, regionQueries, parseTsv, selectFood } from './offline-snapshot';

const row = { code: '4000417025005', product_name: 'Fixture chocolate', brands: 'Fixture', ingredients_text: 'Cocoa, sugar',
  countries_tags: 'en:germany', last_modified_t: 1_700_000_000 };
const date = new Date('2026-10-05T12:00:00Z');
const columns = ['code', 'last_modified_t', 'product_name', 'brands', 'countries_tags', 'ingredients_text', 'unique_scans_n'] as const;
const tsv = (rows: Record<string, unknown>[]) => [columns.join('\t'), ...rows.map(item => columns.map(key => String(item[key] ?? '')).join('\t'))].join('\n') + '\n';
async function* lines(text: string) { yield* text.split('\n').filter(Boolean); }
const exported = (rows: Record<string, unknown>[]) => new Response(Bun.gzipSync(tsv(rows)));

describe('offline snapshot build', () => {
  test('keeps exact composition and provenance but excludes photos, personal fields and unsafe products', () => {
    const result = normalizeProduct({ ...row, image_url: 'https://example.test/photo', creator: 'someone', complete: true });
    expect(result).toEqual({ source: 'off', code: row.code, name: row.product_name, brands: row.brands,
      ingredients: row.ingredients_text, countries_tags: ['en:germany'], last_modified_t: row.last_modified_t });
    expect(normalizeProduct({ ...row, code: '4000417025006' })).toBeUndefined();
    expect(normalizeProduct({ ...row, ingredients_text: 'a'.repeat(12_001) })).toBeUndefined();
  });
  test('filters country mismatches and canonical GTIN duplicates without inventing translated fields', () => {
    const pack = createSnapshot('germany', [[row, { ...row, code: `0${row.code}` }, { ...row, countries_tags: 'en:sweden' }]], date);
    expect(pack.products).toHaveLength(1);
    expect(pack.sources).toEqual([{ id: 'off', url: 'https://world.openfoodfacts.org', license: 'ODbL-1.0', retrievedAt: date.toISOString() }]);
    expect(pack.products[0]).not.toHaveProperty('ingredients_de');
  });
  test('downloadable packs grow past the bundled caps while the de-eu bundle keeps them', () => {
    const gtin = (index: number) => {
      const base = `2${String(index).padStart(11, '0')}`;
      const sum = [...base].reverse().reduce((total, digit, position) => total + Number(digit) * (position % 2 === 0 ? 3 : 1), 0);
      return `${base}${(10 - sum % 10) % 10}`;
    };
    const rows = Array.from({ length: 12_000 }, (_, index) => ({ ...row, code: gtin(index) }));
    expect(regionQueries('germany')[0]?.limit).toBe(30_000);
    expect(createSnapshot('germany', [rows], date).products).toHaveLength(12_000);
    expect(createSnapshot('de-eu', [rows], date).products).toHaveLength(10_000);
  });
  test('food export keeps the most-scanned usable products per recipe, ignoring literal quotes', async () => {
    const swedish = { ...row, code: '7310865004703', countries_tags: 'en:sweden', unique_scans_n: 50 };
    const text = tsv([
      { ...row, code: '4000417025104', unique_scans_n: 3 },
      { ...row, product_name: '"Bio" Schokolade', unique_scans_n: 9 },
      { ...row, code: '4000417025006', unique_scans_n: 99 },
      { ...swedish, countries_tags: 'en:germany,en:sweden', code: '4000417025203', unique_scans_n: 70 },
      swedish,
      { ...row, code: '5000112548167', countries_tags: 'en:france', unique_scans_n: 40 },
    ]);
    const [germany, sweden, eu] = (await selectFood(['de-eu'], lines(text)))[0]!;
    expect(germany!.map(item => (item as { code: string }).code)).toEqual(['4000417025203', '4000417025005', '4000417025104']);
    expect((germany![1] as { product_name: string }).product_name).toBe('"Bio" Schokolade');
    expect(sweden!.map(item => (item as { code: string }).code)).toEqual(['7310865004703']);
    expect(eu!.map(item => (item as { code: string }).code)).toEqual(['5000112548167']);
    await expect(selectFood(['germany'], lines('code\tproduct_name\n'))).rejects.toThrow('Missing food export columns');
  });
  test('one export pass fills every requested pack with its own countries', async () => {
    const text = tsv([
      { ...row, unique_scans_n: 5 },
      { ...row, code: '5000112548167', countries_tags: 'en:ireland,en:united-kingdom', unique_scans_n: 9 },
      { ...row, code: '7310865004703', countries_tags: 'en:switzerland', unique_scans_n: 7 },
      { ...row, code: '4000417025104', countries_tags: 'en:japan', unique_scans_n: 99 },
    ]);
    const codes = (groups: unknown[][]) => groups.map(group => group.map(item => (item as { code: string }).code));
    const [germany, kingdom, ireland, switzerland, eu] = await selectFood(['germany', 'united-kingdom', 'ireland', 'switzerland', 'eu'], lines(text));
    expect([germany, kingdom, ireland, switzerland, eu].map(groups => codes(groups!))).toEqual([
      [['4000417025005']], [['5000112548167']], [['5000112548167']], [['7310865004703']], [['5000112548167', '4000417025005']]]);
    expect(createSnapshot('switzerland', switzerland!, date).products.map(product => product.countries_tags)).toEqual([['en:switzerland']]);
  });
  test('non-food sources keep individual retrieval dates and original composition', () => {
    const older = '2026-10-04T12:00:00.000Z';
    const pack = createSnapshot('germany', [[row]], date, [{ source: 'obf', retrievedAt: older,
      rows: [{ ...row, code: '4000417025104', product_name: 'Fixture cream', ingredients_text: 'Aqua, glycerin' }] }]);
    expect(pack.products).toHaveLength(2);
    expect(pack.sources[1]?.retrievedAt).toBe(older);
    expect(pack.sources[1]?.url).toBe('https://world.openbeautyfacts.org');
    expect(pack.products.find(product => product.source === 'obf')?.ingredients).toBe('Aqua, glycerin');
  });
  test('official TSV preserves escaped quotes and multiline composition, rejects truncated rows', () => {
    const header = 'code\tproduct_name\tbrands\tingredients_text\tcountries_tags\tlast_modified_t\n';
    const text = header + '4000417025005\tFixture\tBrand\t"cocoa, ""sugar""\nsalt"\ten:germany\t1700000000\n';
    expect([...parseTsv(text)][0]?.ingredients_text).toBe('cocoa, "sugar"\nsalt');
    expect(() => [...parseTsv(header + '4000417025005\tFixture')]).toThrow('Incomplete');
    expect(() => [...parseTsv(header + '"unterminated')]).toThrow('Unterminated');
  });
  test('fresh cache does no network; failed stale refresh preserves original bytes and date', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'vegsnap-offline-test-')), sourceCache = await mkdtemp(join(tmpdir(), 'vegsnap-offline-cache-'));
    try {
      const output = join(folder, 'pack.json');
      const original = JSON.stringify(createSnapshot('germany', [[row]], date));
      await writeFile(output, original);
      let requests = 0;
      const fetcher = (async () => { requests++; throw new Error('network unavailable'); });
      expect(await refreshSnapshot({ output, sourceCache, includeNonfood: false, region: 'germany', now: new Date(+date + CACHE_TTL_MS - 1), fetcher, log: () => {} })).toBe('cached');
      expect(requests).toBe(0);
      const warnings: string[] = [];
      expect(await refreshSnapshot({ output, sourceCache, includeNonfood: false, region: 'germany', now: new Date(+date + CACHE_TTL_MS), fetcher, log: message => warnings.push(message) })).toBe('stale');
      expect(await readFile(output, 'utf8')).toBe(original);
      expect(warnings.some(message => message.includes('snapshot age 7 days'))).toBe(true);
      expect(await readdir(folder)).toEqual(['pack.json']);
    } finally { await rm(folder, { recursive: true, force: true }); await rm(sourceCache, { recursive: true, force: true }); }
  });
  test('VEGSNAP_OFFLINE_SNAPSHOT=cached reuses an expired snapshot without network, fails without one, refreshes when forced', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'vegsnap-offline-test-')), sourceCache = await mkdtemp(join(tmpdir(), 'vegsnap-offline-cache-'));
    const previous = process.env.VEGSNAP_OFFLINE_SNAPSHOT;
    process.env.VEGSNAP_OFFLINE_SNAPSHOT = 'cached';
    try {
      const output = join(folder, 'pack.json');
      let requests = 0;
      const fetcher = (async () => { requests++; throw new Error('network unavailable'); });
      const now = new Date(+date + 10 * CACHE_TTL_MS);
      await expect(refreshSnapshot({ output, sourceCache, includeNonfood: false, region: 'germany', now, fetcher, log: () => {} })).rejects.toThrow('No usable germany snapshot');
      expect(requests).toBe(0);
      const original = JSON.stringify(createSnapshot('germany', [[row]], date));
      await writeFile(output, original);
      expect(await refreshSnapshot({ output, sourceCache, includeNonfood: false, region: 'germany', now, fetcher, log: () => {} })).toBe('cached');
      expect(requests).toBe(0);
      expect(await readFile(output, 'utf8')).toBe(original);
      expect(await refreshSnapshot({ output, sourceCache, includeNonfood: false, region: 'germany', now, fetcher, force: true, log: () => {} })).toBe('stale');
      expect(requests).toBe(1);
    } finally {
      if (previous === undefined) delete process.env.VEGSNAP_OFFLINE_SNAPSHOT; else process.env.VEGSNAP_OFFLINE_SNAPSHOT = previous;
      await rm(folder, { recursive: true, force: true }); await rm(sourceCache, { recursive: true, force: true });
    }
  });
  test('rejects unusable exports atomically; a valid refresh replaces the pack and reuses the downloaded export', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'vegsnap-offline-test-')), sourceCache = await mkdtemp(join(tmpdir(), 'vegsnap-offline-cache-'));
    try {
      const output = join(folder, 'pack.json');
      await expect(refreshSnapshot({ output, sourceCache, includeNonfood: false, region: 'germany', now: date, fetcher: (async () => new Response('', { status: 503 })), log: () => {} })).rejects.toThrow('HTTP 503');
      await expect(refreshSnapshot({ output, sourceCache, includeNonfood: false, region: 'germany', now: date, fetcher: (async () => exported([])), log: () => {} })).rejects.toThrow('usable');
      await expect(refreshSnapshot({ output, sourceCache, includeNonfood: false, region: 'germany', now: date, fetcher: (async () => new Response(Bun.gzipSync(tsv([row])).subarray(0, 40))), log: () => {} })).rejects.toThrow();
      expect(await readdir(folder)).toEqual([]);
      expect(await readdir(sourceCache)).toEqual([]);
      let requests = 0;
      const fetcher = (async () => { requests++; return exported([row]); });
      expect(await refreshSnapshot({ output, sourceCache, includeNonfood: false, region: 'germany', now: date, fetcher, log: () => {} })).toBe('updated');
      const later = new Date(+date + 60_000);
      expect(await refreshSnapshot({ output, sourceCache, includeNonfood: false, region: 'germany', force: true, now: later, fetcher, log: () => {} })).toBe('updated');
      const refreshed = JSON.parse(await readFile(output, 'utf8'));
      expect([refreshed.generatedAt, refreshed.sources[0].retrievedAt]).toEqual([later.toISOString(), date.toISOString()]);
      expect(requests).toBe(1);
      expect(refreshed.products[0].code).toBe(row.code);
      expect(await readdir(folder)).toEqual(['pack.json']);
    } finally { await rm(folder, { recursive: true, force: true }); await rm(sourceCache, { recursive: true, force: true }); }
  });
  test('several packs share one export download and keep their cached siblings', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'vegsnap-offline-test-')), sourceCache = await mkdtemp(join(tmpdir(), 'vegsnap-offline-cache-'));
    try {
      const cached = createSnapshot('sweden', [[{ ...row, code: '7310865004703', countries_tags: 'en:sweden' }]], date);
      await writeFile(join(folder, 'sweden.json'), JSON.stringify(cached));
      let requests = 0;
      const fetcher = (async () => { requests++; return exported([row, { ...row, code: '5000112548167', countries_tags: 'en:united-kingdom' }]); });
      const packs = (['germany', 'united-kingdom', 'sweden'] as const).map(region => ({ region, output: join(folder, `${region}.json`) }));
      expect(await refreshSnapshots(packs, { sourceCache, includeNonfood: false, now: new Date(+date + 60_000), fetcher, log: () => {} })).toEqual(['updated', 'updated', 'cached']);
      expect(requests).toBe(1);
      const kingdom = JSON.parse(await readFile(join(folder, 'united-kingdom.json'), 'utf8'));
      expect([kingdom.region, kingdom.products.map((product: { code: string }) => product.code)]).toEqual(['united-kingdom', ['5000112548167']]);
      expect(JSON.parse(await readFile(join(folder, 'sweden.json'), 'utf8'))).toEqual(cached);
    } finally { await rm(folder, { recursive: true, force: true }); await rm(sourceCache, { recursive: true, force: true }); }
  });
});
