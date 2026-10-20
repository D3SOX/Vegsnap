import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCatalog } from './regional-catalog';
import { createSnapshot } from './offline-snapshot';

const date = new Date('2026-10-05T12:00:00Z');
const row = (country: string) => ({ code: '4000417025005', product_name: 'Fixture chocolate', brands: 'Fixture', ingredients_text: 'Cocoa, sugar',
  countries_tags: `en:${country}`, last_modified_t: 1_700_000_000 });

test('catalog describes the exact generated pack bytes', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'vegsnap-catalog-test-'));
  try {
    for (const region of ['germany', 'sweden', 'eu'] as const) {
      await writeFile(join(folder, `${region}.json`), `${JSON.stringify(createSnapshot(region, [[row(region === 'eu' ? 'france' : region)]], date))}\n`);
    }
    const catalog = await createCatalog('https://example.org/releases/v1/', folder);
    expect(catalog.packs.map(pack => pack.id)).toEqual(['germany', 'sweden', 'eu']);
    for (const pack of catalog.packs) {
      const bytes = await readFile(join(folder, `${pack.id}.json`));
      expect(pack).toEqual({ id: pack.id, region: pack.id, url: `https://example.org/releases/v1/${pack.id}.json`, bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'), generatedAt: date.toISOString(), products: 1 });
    }
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test('catalog refuses insecure or credential-bearing download bases', async () => {
  for (const url of ['http://example.org/', 'https://user:secret@example.org/', 'https://example.org/?token=secret']) {
    await expect(createCatalog(url, 'unused')).rejects.toThrow('plain HTTPS');
  }
});
