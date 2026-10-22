import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CATALOG_ASSET, createCatalog, stageRelease } from './regional-catalog';
import { createSnapshot, PACK_REGIONS, PACKS } from './offline-snapshot';

const date = new Date('2026-10-05T12:00:00Z');
const row = (country: string) => ({ code: '4000417025005', product_name: 'Fixture chocolate', brands: 'Fixture', ingredients_text: 'Cocoa, sugar',
  countries_tags: `en:${country}`, last_modified_t: 1_700_000_000 });

test('staged release names packs after their generation time and describes their exact bytes', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'vegsnap-catalog-test-'));
  try {
    for (const region of PACK_REGIONS) {
      await writeFile(join(folder, `${region}.json`), `${JSON.stringify(createSnapshot(region, [[row(PACKS[region].at(-1)!)]], date))}\n`);
    }
    const catalog = await stageRelease('https://example.org/releases/v1/', folder);
    expect(catalog.packs.map(pack => pack.id)).toEqual(['germany', 'sweden', 'eu', 'united-kingdom', 'ireland', 'austria', 'switzerland', 'france',
      'belgium', 'netherlands', 'spain', 'italy', 'norway', 'denmark', 'finland', 'united-states', 'canada', 'australia']);
    expect(JSON.parse(await readFile(join(folder, CATALOG_ASSET), 'utf8'))).toEqual(catalog);
    for (const pack of catalog.packs) {
      const asset = `${pack.id}-20261005120000.json`;
      const bytes = await readFile(join(folder, asset));
      expect(pack).toEqual({ id: pack.id, region: pack.id, url: `https://example.org/releases/v1/${asset}`, bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'), generatedAt: date.toISOString(), products: 1 });
    }
    expect((await readdir(folder)).sort()).toEqual([CATALOG_ASSET, ...PACK_REGIONS.map(region => `${region}-20261005120000.json`)].sort());
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test('catalog refuses insecure or credential-bearing download bases', async () => {
  for (const url of ['http://example.org/', 'https://user:secret@example.org/', 'https://example.org/?token=secret']) {
    await expect(createCatalog(url, 'unused')).rejects.toThrow('plain HTTPS');
  }
});
