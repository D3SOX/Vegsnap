import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CACHE_TTL_MS, createSnapshot, exportUrl, normalizeProduct, refreshSnapshot, regionQueries, parseTsv } from './offline-snapshot';

const row = { code: '4000417025005', product_name: 'Fixture chocolate', brands: 'Fixture', ingredients_text: 'Cocoa, sugar',
  countries_tags: 'en:germany', last_modified_t: 1_700_000_000 };
const date = new Date('2026-10-05T12:00:00Z');
const exported = (rows: unknown[], truncated = false) => Response.json({ ok: true, rows, truncated });

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
    const sql = new URL(exportUrl(regionQueries('de-eu')[0]!)).searchParams.get('sql')!;
    expect(sql).toContain('unique_scans_n DESC, code LIMIT 4000');
    expect(sql).not.toContain('SELECT *');
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
    const folder = await mkdtemp(join(tmpdir(), 'veguide-offline-test-'));
    try {
      const output = join(folder, 'pack.json');
      const original = JSON.stringify(createSnapshot('germany', [[row]], date));
      await writeFile(output, original);
      let requests = 0;
      const fetcher = (async () => { requests++; throw new Error('network unavailable'); });
      expect(await refreshSnapshot({ output, includeNonfood: false, region: 'germany', now: new Date(+date + CACHE_TTL_MS - 1), fetcher, log: () => {} })).toBe('cached');
      expect(requests).toBe(0);
      const warnings: string[] = [];
      expect(await refreshSnapshot({ output, includeNonfood: false, region: 'germany', now: new Date(+date + CACHE_TTL_MS), fetcher, log: message => warnings.push(message) })).toBe('stale');
      expect(await readFile(output, 'utf8')).toBe(original);
      expect(warnings.some(message => message.includes('snapshot age 7 days'))).toBe(true);
      expect(await readdir(folder)).toEqual(['pack.json']);
    } finally { await rm(folder, { recursive: true, force: true }); }
  });
  test('rejects truncated/empty exports atomically; complete valid refresh replaces the cache', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'veguide-offline-test-'));
    try {
      const output = join(folder, 'pack.json');
      const fetcher = (async () => exported([row], true));
      await expect(refreshSnapshot({ output, includeNonfood: false, region: 'germany', now: date, fetcher, log: () => {} })).rejects.toThrow('Incomplete');
      expect(await readdir(folder)).toEqual([]);
      await expect(refreshSnapshot({ output, includeNonfood: false, region: 'germany', now: date, fetcher: (async () => exported([])), log: () => {} })).rejects.toThrow('usable');
      expect(await refreshSnapshot({ output, includeNonfood: false, region: 'germany', now: date, fetcher: (async () => exported([row])), log: () => {} })).toBe('updated');
      const pack = JSON.parse(await readFile(output, 'utf8'));
      expect(pack.products[0].code).toBe(row.code);
      expect(pack.generatedAt).toBe(date.toISOString());
      expect(await readdir(folder)).toEqual(['pack.json']);
    } finally { await rm(folder, { recursive: true, force: true }); }
  });
});
