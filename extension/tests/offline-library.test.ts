import { expect, test } from 'bun:test';
import type { OfflineSnapshot } from '@vegsnap/core';
import { createOfflineLibrary } from '../src/offline-library';
const bundle: OfflineSnapshot = { schemaVersion: 1, generatedAt: '2026-10-05T10:00:00Z', region: 'Bundled DE/EU', sources: [{ id: 'off', url: 'https://world.openfoodfacts.org', license: 'ODbL-1.0', retrievedAt: '2026-10-05T09:00:00Z' }], products: [] };
const extra: OfflineSnapshot = { ...bundle, region: 'Sweden', products: [{ source: 'off', code: '4006381333931', name: 'Example', brands: 'Example', ingredients: 'milk', countries_tags: ['en:sweden'], last_modified_t: 1760000000 }] };
test('pack import validates before writing and commits the index only after storage succeeds', async () => {
  let stored: OfflineSnapshot[] = [];
  let fail = false;
  const library = createOfflineLibrary({ read: async () => stored, put: async pack => { if (fail) throw new Error('Storage full'); stored = [pack]; }, remove: async () => { stored = []; } }, bundle);
  await library.import(JSON.stringify(extra));
  expect((await library.index()).lookup('4006381333931', { market: 'SE' })?.input.name).toBe('Example');
  expect(await library.info()).toHaveLength(2);
  await expect(library.import('{bad json')).rejects.toThrow();
  expect(stored[0]?.region).toBe('Sweden');
  fail = true;
  await expect(library.import(JSON.stringify({ ...extra, products: [] }))).rejects.toThrow('Storage full');
  expect((await library.index()).lookup('4006381333931', { market: 'SE' })).not.toBeNull();
  expect((await library.info()).find(pack => !pack.bundled)?.count).toBe(1);
  fail = false;
  await library.remove('Sweden');
  expect((await library.index()).lookup('4006381333931', { market: 'SE' })).toBeNull();
  expect(await library.info()).toEqual([{ region: bundle.region, generatedAt: bundle.generatedAt, count: 0, bundled: true }]);
});
test('imported packs are bounded by their total size', async () => {
  let stored: OfflineSnapshot[] = [];
  const library = createOfflineLibrary({ read: async () => stored, put: async pack => { stored = [...stored.filter(p => p.region !== pack.region), pack]; }, remove: async region => { stored = stored.filter(p => p.region !== region); } }, bundle);
  const gtin = (index: number) => { const base = `2${String(index).padStart(11, '0')}`; const sum = [...base].reverse().reduce((total, digit, position) => total + Number(digit) * (position % 2 === 0 ? 3 : 1), 0); return base + (10 - sum % 10) % 10; };
  const large = (region: string) => JSON.stringify({ ...bundle, region, products: Array.from({ length: 1_600 }, (_, index) => ({ source: 'off', code: gtin(index), name: `Product ${index}`, brands: 'Brand', ingredients: 'x'.repeat(12_000), countries_tags: ['en:sweden'], last_modified_t: 1760000000 })) });
  for (const region of ['A', 'B', 'C']) await library.import(large(region));
  await expect(library.import(large('D'))).rejects.toThrow('60 MB in total');
  expect(stored.map(pack => pack.region)).toEqual(['A', 'B', 'C']);
  await library.import(large('B')); // Replacing a pack does not count it twice.
  await library.remove('A');
  await library.import(large('D'));
  expect((await library.info()).filter(pack => !pack.bundled).map(pack => pack.region).sort()).toEqual(['B', 'C', 'D']);
}, 60_000);
