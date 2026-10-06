import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeBarcode } from '../packages/core/src/database';
import { validateOfflineSnapshot } from '../packages/core/src/offline';

export const MAX_BYTES = 10_000_000;
export const MAX_PRODUCTS = 10_000;
export const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
type SnapshotFetch = (url: string, init?: RequestInit) => Promise<Response>;
export type Region = 'de-eu' | 'germany' | 'sweden' | 'eu';
export type SourceId = 'off' | 'obf' | 'opf';
export interface OfflineProduct {
  source: SourceId; code: string; name: string; brands: string; ingredients: string;
  countries_tags: string[]; last_modified_t: number;
}
export interface OfflineSnapshot {
  schemaVersion: 1; generatedAt: string; region: Region;
  sources: { id: SourceId; url: string; license: 'ODbL-1.0'; retrievedAt: string }[];
  products: OfflineProduct[];
}
const SOURCE = 'https://world.openfoodfacts.org';
const ORIGINS: Record<SourceId, string> = { off: SOURCE, obf: 'https://world.openbeautyfacts.org', opf: 'https://world.openproductsfacts.org' };
const DOMAIN: Record<'obf' | 'opf', string> = { obf: 'openbeautyfacts', opf: 'openproductsfacts' };
const EXPORT = 'https://mirabelle.openfoodfacts.org/products.json';
const EU = ['austria', 'belgium', 'bulgaria', 'croatia', 'cyprus', 'czech-republic', 'denmark', 'estonia',
  'finland', 'france', 'germany', 'greece', 'hungary', 'ireland', 'italy', 'latvia', 'lithuania', 'luxembourg',
  'malta', 'netherlands', 'poland', 'portugal', 'romania', 'slovakia', 'slovenia', 'spain', 'sweden'];
export function regionQueries(region: Region): { countries: string[]; exclude: string[]; limit: number }[] {
  if (region === 'germany' || region === 'sweden') return [{ countries: [region], exclude: [], limit: 8_000 }];
  if (region === 'eu') return [{ countries: EU, exclude: [], limit: 8_000 }];
  return [
    { countries: ['germany'], exclude: [], limit: 4_000 },
    { countries: ['sweden'], exclude: ['germany'], limit: 1_500 },
    { countries: EU.filter(country => country !== 'germany' && country !== 'sweden'), exclude: ['germany', 'sweden'], limit: 2_500 },
  ];
}
export function exportUrl(query: ReturnType<typeof regionQueries>[number]): string {
  // All country names and limits come from the fixed recipes above, never user SQL.
  const match = (country: string) => `countries_tags LIKE '%en:${country}%'`;
  const where = [`(${query.countries.map(match).join(' OR ')})`, ...query.exclude.map(country => `NOT (${match(country)})`),
    "length(product_name) BETWEEN 1 AND 500", "length(brands) <= 500", "length(ingredients_text) <= 12000"];
  const sql = `SELECT code,product_name,brands,ingredients_text,countries_tags,last_modified_t FROM [all] WHERE ${where.join(' AND ')} ORDER BY unique_scans_n DESC, code LIMIT ${query.limit}`;
  const url = new URL(EXPORT);
  url.searchParams.set('sql', sql); url.searchParams.set('_shape', 'objects'); url.searchParams.set('_size', 'max');
  return url.href;
}
function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function bounded(value: unknown, limit: number): string | undefined {
  return typeof value === 'string' && value.length <= limit && !/[\u0000]/u.test(value) ? value.trim() : undefined;
}
export function normalizeProduct(raw: unknown, source: SourceId = 'off'): OfflineProduct | undefined {
  const row = object(raw);
  if (!row) return;
  const code = typeof row.code === 'string' ? normalizeBarcode(row.code) : undefined;
  const name = bounded(row.product_name, 500), brands = bounded(row.brands ?? '', 500), ingredients = bounded(row.ingredients_text ?? '', 12_000);
  const countries = typeof row.countries_tags === 'string' ? row.countries_tags.split(',').map(tag => tag.trim()).filter(Boolean) : [];
  const modified = row.last_modified_t;
  if (!code || !name || brands === undefined || ingredients === undefined || countries.length > 64 ||
      countries.some(tag => !/^en:[a-z0-9-]{1,77}$/.test(tag)) || typeof modified !== 'number' || !Number.isSafeInteger(modified) || modified < 0 || !Number.isFinite(new Date(modified * 1000).getTime())) return;
  return { source, code, name, brands, ingredients, countries_tags: [...new Set(countries)].sort(), last_modified_t: modified };
}
export function createSnapshot(region: Region, groups: unknown[][], time: Date, extra: { source: 'obf' | 'opf'; rows: unknown[]; retrievedAt: string }[] = []): OfflineSnapshot {
  const iso = time.toISOString();
  const pack: OfflineSnapshot = { schemaVersion: 1, generatedAt: iso, region,
    sources: [{ id: 'off', url: SOURCE, license: 'ODbL-1.0', retrievedAt: iso }], products: [] };
  const seen = new Set<string>();
  let bytes = Buffer.byteLength(JSON.stringify(pack)) + 1;
  for (let group = 0; group < groups.length; group++) {
    const recipe = regionQueries(region)[group];
    if (!recipe) throw new Error('Unexpected export group');
    for (const row of groups[group]!) {
      const product = normalizeProduct(row);
      if (!product || !recipe.countries.some(country => product.countries_tags.includes(`en:${country}`)) ||
          recipe.exclude.some(country => product.countries_tags.includes(`en:${country}`))) continue;
      const key = product.code.padStart(14, '0');
      if (seen.has(key)) continue;
      const size = Buffer.byteLength(JSON.stringify(product)) + 1;
      if (bytes + size > MAX_BYTES || pack.products.length >= MAX_PRODUCTS) break;
      bytes += size; seen.add(key); pack.products.push(product);
    }
  }
  if (!pack.products.length) throw new Error('Export did not contain usable products');
  for (const dataset of extra) {
    const candidates = dataset.rows.map(row => normalizeProduct(row, dataset.source)).filter((row): row is OfflineProduct => !!row);
    const priority = (row: OfflineProduct): number => row.countries_tags.includes('en:germany') ? 0 : row.countries_tags.includes('en:sweden') ? 1 : 2;
    const wanted = region === 'germany' || region === 'sweden' ? [region] : EU;
    candidates.sort((a, b) => (region === 'de-eu' ? priority(a) - priority(b) : 0) || Number(!a.ingredients) - Number(!b.ingredients) || a.code.localeCompare(b.code));
    let selected = 0;
    for (const product of candidates) {
      if (!wanted.some(country => product.countries_tags.includes(`en:${country}`))) continue;
      const key = product.code.padStart(14, '0');
      if (seen.has(key)) continue;
      const size = Buffer.byteLength(JSON.stringify(product)) + 1;
      if (selected >= 1_000 || pack.products.length >= MAX_PRODUCTS || bytes + size + 300 > MAX_BYTES) break;
      bytes += size; selected++; seen.add(key); pack.products.push(product);
    }
    if (selected) { pack.sources.push({ id: dataset.source, url: ORIGINS[dataset.source], license: 'ODbL-1.0', retrievedAt: dataset.retrievedAt }); bytes += 300; }
  }
  pack.products.sort((a, b) => a.code.padStart(14, '0').localeCompare(b.code.padStart(14, '0')));
  return pack;
}
export function usableSnapshot(raw: unknown, region: Region): raw is OfflineSnapshot {
  try {
    const snapshot = validateOfflineSnapshot(raw);
    return snapshot.region === region && snapshot.products.length > 0;
  } catch { return false; }
}
async function readSnapshot(path: string, region: Region): Promise<OfflineSnapshot | undefined> {
  try {
    const bytes = await readFile(path);
    if (bytes.length > MAX_BYTES) return;
    const raw: unknown = JSON.parse(bytes.toString('utf8'));
    return usableSnapshot(raw, region) ? raw : undefined;
  } catch { return; }
}
async function readExport(response: Response): Promise<unknown[]> {
  if (!response.ok) throw new Error(`Export HTTP ${response.status}`);
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Empty export response');
  const chunks: Uint8Array[] = []; let length = 0;
  try {
    while (true) {
      const next = await reader.read(); if (next.done) break;
      length += next.value.byteLength;
      if (length > 24 * 1024 * 1024) throw new Error('Export exceeds download bound');
      chunks.push(next.value);
    }
  } finally { await reader.cancel(); }
  const raw: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const result = object(raw);
  if (result?.ok !== true || result.truncated !== false || !Array.isArray(result.rows) || result.rows.length > MAX_PRODUCTS) throw new Error('Incomplete or invalid export');
  return result.rows;
}
export function* parseTsv(text: string): Generator<Record<string, string>> {
  let headers: string[] | undefined, fields: string[] = [], field = '', quoted = false;
  const emit = (): Record<string, string> | undefined => {
    fields.push(field); field = '';
    if (!headers) {
      headers = fields.map(header => header.replace(/^\uFEFF/u, ''));
      if (!['code', 'product_name', 'countries_tags', 'last_modified_t'].every(key => headers!.includes(key))) throw new Error('Missing TSV columns');
      fields = []; return;
    }
    if (fields.length === 1 && fields[0] === '') { fields = []; return; }
    if (fields.length !== headers.length) throw new Error('Incomplete TSV row');
    const result: Record<string, string> = {};
    for (const key of ['code', 'product_name', 'brands', 'ingredients_text', 'countries_tags', 'last_modified_t']) {
      const index = headers.indexOf(key); if (index >= 0) result[key] = fields[index]!;
    }
    fields = []; return result;
  };
  for (let i = 0; i < text.length; i++) {
    const character = text[i]!;
    if (quoted) {
      if (character === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += character;
    } else if (character === '"' && field === '') quoted = true;
    else if (character === '\t') { fields.push(field); field = ''; }
    else if (character === '\n' || character === '\r') {
      if (character === '\r' && text[i + 1] === '\n') i++;
      const row = emit(); if (row) yield row;
    } else field += character;
  }
  if (quoted) throw new Error('Unterminated TSV field');
  if (field || fields.length) { const row = emit(); if (row) yield row; }
}
async function boundedBytes(body: ReadableStream<Uint8Array> | null, limit: number): Promise<Buffer> {
  const reader = body?.getReader(); if (!reader) throw new Error('Empty download');
  const chunks: Uint8Array[] = []; let length = 0;
  try {
    while (true) {
      const next = await reader.read(); if (next.done) break;
      length += next.value.byteLength; if (length > limit) throw new Error('Download exceeds size bound');
      chunks.push(next.value);
    }
  } finally { await reader.cancel(); }
  return Buffer.concat(chunks);
}
async function nonfoodRows(source: 'obf' | 'opf', cache: string, now: Date, fetcher: SnapshotFetch): Promise<{ source: 'obf' | 'opf'; rows: unknown[]; retrievedAt: string }> {
  const path = resolve(cache, `${source}.csv.gz`), metadataPath = `${path}.json`;
  let bytes: Buffer | undefined, retrievedAt = now.toISOString();
  const digest = (data: Uint8Array) => new Bun.CryptoHasher('sha256').update(data).digest('hex');
  try {
    const metadata: unknown = JSON.parse(await readFile(metadataPath, 'utf8'));
    const entry = object(metadata);
    const age = typeof entry?.retrievedAt === 'string' ? now.getTime() - Date.parse(entry.retrievedAt) : Infinity;
    if (age >= 0 && age < CACHE_TTL_MS) {
      const candidate = await readFile(path);
      if (candidate.length <= 32 * 1024 * 1024 && entry?.sha256 === digest(candidate)) { bytes = candidate; retrievedAt = entry.retrievedAt as string; }
    }
  } catch { /* Missing/invalid cache is refreshed from the official export. */ }
  if (!bytes) {
    const domain = DOMAIN[source];
    const url = `https://static.${domain}.org/data/en.${domain}.org.products.csv.gz`;
    const response = await fetcher(url, { headers: { 'User-Agent': 'Vegsnap/0.1 (build-time offline snapshot)' }, redirect: 'error', signal: AbortSignal.timeout(60_000) });
    if (!response.ok) throw new Error(`${source} export HTTP ${response.status}`);
    bytes = await boundedBytes(response.body, 32 * 1024 * 1024);
    const temporary = `${path}.${crypto.randomUUID()}.tmp`;
    await mkdir(cache, { recursive: true });
    try {
      await writeFile(temporary, bytes, { flag: 'wx' }); await rename(temporary, path);
      await writeFile(`${temporary}.json`, JSON.stringify({ url, retrievedAt, sourceDate: response.headers.get('last-modified'), sha256: digest(bytes) }), { flag: 'wx' });
      await rename(`${temporary}.json`, metadataPath);
    } finally { await rm(temporary, { force: true }); await rm(`${temporary}.json`, { force: true }); }
  }
  const decompressed = new Blob([new Uint8Array(bytes)]).stream().pipeThrough(new DecompressionStream('gzip'));
  const text = (await boundedBytes(decompressed, 256 * 1024 * 1024)).toString('utf8');
  const rows: unknown[] = [];
  for (const row of parseTsv(text)) {
    if (rows.length >= 200_000) throw new Error('Non-food export exceeds row bound');
    rows.push({ ...row, last_modified_t: Number(row.last_modified_t) });
  }
  return { source, rows, retrievedAt };
}
export async function refreshSnapshot(options: { output: string; region?: Region; force?: boolean; strict?: boolean;
  fetcher?: SnapshotFetch; now?: Date; sourceCache?: string; includeNonfood?: boolean; log?: (message: string) => void }): Promise<'cached' | 'updated' | 'stale'> {
  const region = options.region ?? 'de-eu', now = options.now ?? new Date(), log = options.log ?? console.log;
  const existing = await readSnapshot(options.output, region);
  const age = existing ? now.getTime() - Date.parse(existing.generatedAt) : Infinity;
  if (existing && !options.force && age >= 0 && age < CACHE_TTL_MS && existing.sources.every(source => now.getTime() - Date.parse(source.retrievedAt) >= 0 && now.getTime() - Date.parse(source.retrievedAt) < CACHE_TTL_MS)) {
    log(`Offline ${region}: using ${existing.products.length} products from ${existing.generatedAt} (7-day cache).`); return 'cached';
  }
  const temporary = `${options.output}.${crypto.randomUUID()}.tmp`;
  try {
    const groups: unknown[][] = [];
    for (const query of regionQueries(region)) {
      log(`Offline ${region}: fetching ${query.limit} food candidates for ${query.countries.length === 1 ? query.countries[0] : 'EU'}.`);
      const response = await (options.fetcher ?? fetch)(exportUrl(query), { headers: { Accept: 'application/json', 'User-Agent': 'Vegsnap/0.1 (build-time offline snapshot)' },
        redirect: 'error', signal: AbortSignal.timeout(60_000) });
      groups.push(await readExport(response));
    }
    const extra: { source: 'obf' | 'opf'; rows: unknown[]; retrievedAt: string }[] = [];
    if (options.includeNonfood !== false) {
      const cache = options.sourceCache ?? resolve(dirname(options.output), '..', '..', 'artifacts/offline/source-cache');
      for (const source of ['obf', 'opf'] as const) {
        log(`Offline ${region}: preparing ${source} regional export.`);
        extra.push(await nonfoodRows(source, cache, now, options.fetcher ?? fetch));
      }
    }
    const pack = createSnapshot(region, groups, now, extra);
    const content = `${JSON.stringify(pack)}\n`;
    if (Buffer.byteLength(content) > MAX_BYTES) throw new Error('Snapshot exceeds bundle size limit');
    await mkdir(dirname(options.output), { recursive: true });
    await writeFile(temporary, content, { flag: 'wx' });
    await rename(temporary, options.output);
    log(`Offline ${region}: updated ${pack.products.length} products, ${(Buffer.byteLength(content) / 1024 / 1024).toFixed(2)} MiB, ${pack.generatedAt}.`);
    return 'updated';
  } catch (error) {
    await rm(temporary, { force: true });
    if (!existing || options.strict) throw error;
    log(`WARNING: Offline refresh failed (${error instanceof Error ? error.message : 'unknown error'}). Keeping ${existing.products.length} products from ${existing.generatedAt}; snapshot age ${Math.max(0, Math.floor(age / 86_400_000))} days.`);
    return 'stale';
  }
}
if (import.meta.main) {
  const args = process.argv.slice(2);
  const value = (key: string) => { const index = args.indexOf(key); return index < 0 ? undefined : args[index + 1]; };
  const region = value('--region') ?? 'de-eu';
  if (['--region', '--output'].some(key => args.includes(key) && (!value(key) || value(key)!.startsWith('--'))) || !['de-eu', 'germany', 'sweden', 'eu'].includes(region) || args.some((arg, index) =>
    !['--region', '--output', '--force', '--strict'].includes(arg) && !['--region', '--output'].includes(args[index - 1] ?? ''))) throw new Error('Usage: bun scripts/offline-snapshot.ts [--region de-eu|germany|sweden|eu] [--output path] [--force] [--strict]');
  const root = fileURLToPath(new URL('..', import.meta.url));
  const lock = resolve(root, 'artifacts/offline/refresh.lock');
  await mkdir(dirname(lock), { recursive: true });
  const deadline = Date.now() + 240_000;
  while (true) {
    try { await mkdir(lock); await writeFile(`${lock}/owner.json`, JSON.stringify({ pid: process.pid, createdAt: Date.now() })); break; }
    catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error;
      try {
        const owner = object(JSON.parse(await readFile(`${lock}/owner.json`, 'utf8')));
        if (typeof owner?.pid === 'number' && Number.isInteger(owner.pid) && owner.pid > 0) {
          try { process.kill(owner.pid, 0); } catch (reason) {
            if (reason instanceof Error && 'code' in reason && reason.code === 'ESRCH') { await rm(lock, { recursive: true, force: true }); continue; }
          }
        }
      } catch { /* The lock owner may still be writing its metadata. */ }
      if (Date.now() >= deadline) throw new Error('Offline snapshot refresh is still running in another build. Retry after it finishes.');
      await Bun.sleep(500);
    }
  }
  try {
    await refreshSnapshot({ region: region as Region, output: resolve(value('--output') ?? (region === 'de-eu' ? `${root}/data/offline/bundle.json` : `${root}/artifacts/offline/${region}.json`)), sourceCache: resolve(root, 'artifacts/offline/source-cache'), force: args.includes('--force'), strict: args.includes('--strict') });
  } finally { await rm(lock, { recursive: true, force: true }); }
}
