import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { validateOfflineSnapshot, OFFLINE_MAX_BYTES } from '../packages/core/src/offline';

export async function createCatalog(baseUrl: string, directory = 'regional-packs') {
  const base = new URL(baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) throw new Error('Use a plain HTTPS release asset base URL.');
  const packs = [];
  for (const id of ['germany', 'sweden', 'eu']) {
    const bytes = await readFile(`${directory}/${id}.json`);
    if (bytes.length > OFFLINE_MAX_BYTES) throw new Error(`Pack too large: ${id}`);
    const pack = validateOfflineSnapshot(JSON.parse(bytes.toString('utf8')));
    if (pack.region !== id) throw new Error(`Region mismatch: ${id}`);
    packs.push({ id, region: pack.region, url: new URL(`${id}.json`, base).href,
      bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
      generatedAt: pack.generatedAt, products: pack.products.length });
  }
  return { schemaVersion: 1, packs };
}

if (import.meta.main) {
  const base = process.argv[2];
  if (!base) throw new Error('Usage: bun scripts/regional-catalog.ts HTTPS_RELEASE_ASSET_BASE [OUTPUT]');
  const catalog = await createCatalog(base);
  await writeFile(process.argv[3] ?? 'regional-packs/catalog.json', `${JSON.stringify(catalog, null, 2)}\n`);
}
