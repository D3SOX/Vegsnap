import { createHash } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { validateOfflineSnapshot, OFFLINE_MAX_BYTES } from '../packages/core/src/offline';

/** Clients released before 20 MB packs keep reading the frozen catalog.json; current clients fetch this asset. */
export const CATALOG_ASSET = 'catalog-v2.json';
/** Packs are immutable release assets named after their generation time, so a catalog never points at replaced bytes. */
export function packAsset(id: string, generatedAt: string): string { return `${id}-${generatedAt.replace(/\D/g, '').slice(0, 14)}.json`; }

export async function createCatalog(baseUrl: string, directory: string) {
  const base = new URL(baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) throw new Error('Use a plain HTTPS release asset base URL.');
  const packs = [];
  for (const id of ['germany', 'sweden', 'eu']) {
    const bytes = await readFile(`${directory}/${id}.json`);
    if (bytes.length > OFFLINE_MAX_BYTES) throw new Error(`Pack too large: ${id}`);
    const pack = validateOfflineSnapshot(JSON.parse(bytes.toString('utf8')));
    if (pack.region !== id) throw new Error(`Region mismatch: ${id}`);
    packs.push({ id, region: pack.region, url: new URL(packAsset(id, pack.generatedAt), base).href,
      bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
      generatedAt: pack.generatedAt, products: pack.products.length });
  }
  return { schemaVersion: 1, packs };
}

/** Renames the packs to their asset names and writes the catalog next to them, ready for `gh release upload`. */
export async function stageRelease(baseUrl: string, directory: string) {
  const catalog = await createCatalog(baseUrl, directory);
  for (const pack of catalog.packs) await rename(`${directory}/${pack.id}.json`, `${directory}/${basename(new URL(pack.url).pathname)}`);
  await writeFile(`${directory}/${CATALOG_ASSET}`, `${JSON.stringify(catalog, null, 2)}\n`);
  return catalog;
}

if (import.meta.main) {
  const [base, directory] = process.argv.slice(2);
  if (!base || !directory) throw new Error('Usage: bun scripts/regional-catalog.ts HTTPS_RELEASE_ASSET_BASE PACK_DIRECTORY');
  await stageRelease(base, directory);
}
