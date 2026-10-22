import { createReadStream } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { pipeline } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { createGunzip } from 'node:zlib';
import { normalizeBarcode } from '../packages/core/src/database';
import { OFFLINE_MAX_BYTES, OFFLINE_MAX_PRODUCTS, validateOfflineSnapshot } from '../packages/core/src/offline';

export const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
type SnapshotFetch = (url: string, init?: RequestInit) => Promise<Response>;
/** The bundled de-eu snapshot ships inside the apps, so it keeps its small caps; downloadable packs fill the client limits. */
export function packLimits(region: Region): { bytes: number; products: number; nonfood: number } {
  return region === 'de-eu' ? { bytes: 10_000_000, products: 10_000, nonfood: 1_000 } : { bytes: OFFLINE_MAX_BYTES, products: OFFLINE_MAX_PRODUCTS, nonfood: 2_000 };
}
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
const FOOD_EXPORT = 'https://static.openfoodfacts.org/data/en.openfoodfacts.org.products.csv.gz';
const FOOD_EXPORT_BYTES = 4 * 1024 ** 3;
const EU = ['austria', 'belgium', 'bulgaria', 'croatia', 'cyprus', 'czech-republic', 'denmark', 'estonia',
  'finland', 'france', 'germany', 'greece', 'hungary', 'ireland', 'italy', 'latvia', 'lithuania', 'luxembourg',
  'malta', 'netherlands', 'poland', 'portugal', 'romania', 'slovakia', 'slovenia', 'spain', 'sweden'];
/** Downloadable packs, in catalog order, and the Open Food Facts countries each one covers. */
export const PACKS = {
  germany: ['germany'], sweden: ['sweden'], eu: EU, 'united-kingdom': ['united-kingdom'], ireland: ['ireland'],
  austria: ['austria'], switzerland: ['switzerland'], france: ['france'], belgium: ['belgium'], netherlands: ['netherlands'],
  spain: ['spain'], italy: ['italy'], norway: ['norway'], denmark: ['denmark'], finland: ['finland'],
  'united-states': ['united-states'], canada: ['canada'], australia: ['australia'],
} as const satisfies Record<string, readonly string[]>;
export type PackRegion = keyof typeof PACKS;
export type Region = 'de-eu' | PackRegion;
export const PACK_REGIONS = Object.keys(PACKS) as PackRegion[];
export function regionQueries(region: Region): { countries: readonly string[]; exclude: string[]; limit: number }[] {
  if (region !== 'de-eu') return [{ countries: PACKS[region], exclude: [], limit: 30_000 }];
  return [
    { countries: ['germany'], exclude: [], limit: 4_000 },
    { countries: ['sweden'], exclude: ['germany'], limit: 1_500 },
    { countries: EU.filter(country => country !== 'germany' && country !== 'sweden'), exclude: ['germany', 'sweden'], limit: 2_500 },
  ];
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
  const seen = new Set<string>(), limits = packLimits(region);
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
      if (bytes + size > limits.bytes || pack.products.length >= limits.products) break;
      bytes += size; seen.add(key); pack.products.push(product);
    }
  }
  if (!pack.products.length) throw new Error('Export did not contain usable products');
  for (const dataset of extra) {
    const candidates = dataset.rows.map(row => normalizeProduct(row, dataset.source)).filter((row): row is OfflineProduct => !!row);
    const priority = (row: OfflineProduct): number => row.countries_tags.includes('en:germany') ? 0 : row.countries_tags.includes('en:sweden') ? 1 : 2;
    const wanted = region === 'de-eu' ? EU : PACKS[region];
    candidates.sort((a, b) => (region === 'de-eu' ? priority(a) - priority(b) : 0) || Number(!a.ingredients) - Number(!b.ingredients) || a.code.localeCompare(b.code));
    let selected = 0;
    for (const product of candidates) {
      if (!wanted.some(country => product.countries_tags.includes(`en:${country}`))) continue;
      const key = product.code.padStart(14, '0');
      if (seen.has(key)) continue;
      const size = Buffer.byteLength(JSON.stringify(product)) + 1;
      if (selected >= limits.nonfood || pack.products.length >= limits.products || bytes + size + 300 > limits.bytes) break;
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
    if (bytes.length > packLimits(region).bytes) return;
    const raw: unknown = JSON.parse(bytes.toString('utf8'));
    return usableSnapshot(raw, region) ? raw : undefined;
  } catch { return; }
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
/** Locates one field without splitting the line, so the millions of products outside every region cost a partial scan each. */
function tsvField(line: string, index: number): string {
  let start = 0;
  for (let column = 0; column < index; column++) { start = line.indexOf('\t', start) + 1; if (!start) return ''; }
  const end = line.indexOf('\t', start);
  return line.slice(start, end < 0 ? undefined : end);
}
/** One pass over the official food export keeps each region's most-scanned usable products per recipe, in the order createSnapshot fills packs. */
export async function selectFood(regions: readonly Region[], rows: AsyncIterable<string>): Promise<unknown[][][]> {
  const recipes = regions.flatMap((region, index) => regionQueries(region).map(recipe => ({ ...recipe, region: index })));
  const tags = new Set(recipes.flatMap(recipe => recipe.countries).map(country => `en:${country}`));
  const groups = recipes.map(() => [] as { scans: number; code: string; row: Record<string, unknown> }[]);
  const rank = (a: { scans: number; code: string }, b: { scans: number; code: string }) =>
    b.scans - a.scans || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0);
  let columns: Record<string, number> | undefined;
  for await (const line of rows) {
    // The export has no quoting: every line is one product, and fields never contain tabs or newlines.
    if (!columns) {
      const headers = line.replace(/^\uFEFF/u, '').split('\t');
      columns = Object.fromEntries(['code', 'product_name', 'brands', 'ingredients_text', 'countries_tags', 'last_modified_t', 'unique_scans_n'].map(key => [key, headers.indexOf(key)]));
      if (Object.values(columns).some(index => index < 0)) throw new Error('Missing food export columns');
      continue;
    }
    if (!tsvField(line, columns.countries_tags!).split(',').some(tag => tags.has(tag))) continue;
    const fields = line.split('\t'), field = (key: string) => fields[columns![key]!] ?? '';
    const row = { code: field('code'), product_name: field('product_name'), brands: field('brands'), ingredients_text: field('ingredients_text'),
      countries_tags: field('countries_tags'), last_modified_t: Number(field('last_modified_t')) };
    const product = normalizeProduct(row);
    if (!product) continue;
    const scans = Number(field('unique_scans_n')) || 0;
    let copy: Record<string, unknown> | undefined;
    recipes.forEach((recipe, index) => {
      if (!recipe.countries.some(country => product.countries_tags.includes(`en:${country}`)) ||
          recipe.exclude.some(country => product.countries_tags.includes(`en:${country}`))) return;
      const group = groups[index]!;
      // Split fields share the decompressed chunk's memory; one copy per product lets each chunk be freed.
      copy ??= JSON.parse(JSON.stringify(row)) as Record<string, unknown>;
      group.push({ scans, code: copy.code as string, row: copy });
      if (group.length >= 2 * recipe.limit) { group.sort(rank); group.length = recipe.limit; }
    });
  }
  if (!columns) throw new Error('Empty food export');
  if (groups.every(group => !group.length)) throw new Error('Export did not contain usable products');
  const selected = groups.map((group, index) => group.sort(rank).slice(0, recipes[index]!.limit).map(entry => entry.row));
  return regions.map((_, region) => selected.filter((_, index) => recipes[index]!.region === region));
}
async function foodExport(cache: string, now: Date, fetcher: SnapshotFetch): Promise<{ path: string; retrievedAt: string }> {
  const path = resolve(cache, 'off.csv.gz'), metadataPath = `${path}.json`;
  try {
    const entry = object(JSON.parse(await readFile(metadataPath, 'utf8')));
    const age = typeof entry?.retrievedAt === 'string' ? now.getTime() - Date.parse(entry.retrievedAt) : Infinity;
    if (age >= 0 && age < CACHE_TTL_MS && entry?.bytes === Bun.file(path).size) return { path, retrievedAt: entry.retrievedAt as string };
  } catch { /* Missing/invalid cache is refreshed from the official export. */ }
  // The static URL redirects to the current file on Open Food Facts' S3 bucket.
  const response = await fetcher(FOOD_EXPORT, { headers: { 'User-Agent': 'Vegsnap/0.1 (build-time offline snapshot)' }, signal: AbortSignal.timeout(1_800_000) });
  if (!response.ok) throw new Error(`off export HTTP ${response.status}`);
  if (Number(response.headers.get('content-length') ?? 0) > FOOD_EXPORT_BYTES) throw new Error('Download exceeds size bound');
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  await mkdir(cache, { recursive: true });
  try {
    const bytes = await Bun.write(temporary, response);
    if (bytes > FOOD_EXPORT_BYTES) throw new Error('Download exceeds size bound');
    await rename(temporary, path);
    await writeFile(`${temporary}.json`, JSON.stringify({ url: FOOD_EXPORT, retrievedAt: now.toISOString(), sourceDate: response.headers.get('last-modified'), bytes }), { flag: 'wx' });
    await rename(`${temporary}.json`, metadataPath);
  } finally { await rm(temporary, { force: true }); await rm(`${temporary}.json`, { force: true }); }
  return { path, retrievedAt: now.toISOString() };
}
type RefreshStatus = 'cached' | 'updated' | 'stale';
interface RefreshOptions { force?: boolean; strict?: boolean; fetcher?: SnapshotFetch; now?: Date; sourceCache?: string; includeNonfood?: boolean; log?: (message: string) => void }
export async function refreshSnapshot(options: RefreshOptions & { output: string; region?: Region }): Promise<RefreshStatus> {
  return (await refreshSnapshots([{ region: options.region ?? 'de-eu', output: options.output }], options))[0]!;
}
/** Refreshes every pack that is not cached from a single read of each export. */
export async function refreshSnapshots(packs: { region: Region; output: string }[], options: RefreshOptions = {}): Promise<RefreshStatus[]> {
  const now = options.now ?? new Date(), log = options.log ?? console.log;
  const existing = await Promise.all(packs.map(pack => readSnapshot(pack.output, pack.region)));
  const statuses: (RefreshStatus | undefined)[] = packs.map(({ region, output }, index) => {
    const snapshot = existing[index];
    if (!options.force && process.env.VEGSNAP_OFFLINE_SNAPSHOT === 'cached') {
      if (!snapshot) throw new Error(`No usable ${region} snapshot at ${output} for VEGSNAP_OFFLINE_SNAPSHOT=cached`);
      log(`Offline ${region}: using ${snapshot.products.length} products from ${snapshot.generatedAt} (VEGSNAP_OFFLINE_SNAPSHOT=cached).`); return 'cached';
    }
    const age = snapshot ? now.getTime() - Date.parse(snapshot.generatedAt) : Infinity;
    if (snapshot && !options.force && age >= 0 && age < CACHE_TTL_MS && snapshot.sources.every(source => now.getTime() - Date.parse(source.retrievedAt) >= 0 && now.getTime() - Date.parse(source.retrievedAt) < CACHE_TTL_MS)) {
      log(`Offline ${region}: using ${snapshot.products.length} products from ${snapshot.generatedAt} (7-day cache).`); return 'cached';
    }
    return undefined;
  });
  const stale = (index: number, error: unknown): RefreshStatus => {
    const snapshot = existing[index];
    if (!snapshot || options.strict) throw error;
    const age = now.getTime() - Date.parse(snapshot.generatedAt);
    log(`WARNING: Offline ${packs[index]!.region} refresh failed (${error instanceof Error ? error.message : 'unknown error'}). Keeping ${snapshot.products.length} products from ${snapshot.generatedAt}; snapshot age ${Math.max(0, Math.floor(age / 86_400_000))} days.`);
    return 'stale';
  };
  const pending = packs.flatMap((_, index) => statuses[index] ? [] : [index]);
  if (!pending.length) return statuses as RefreshStatus[];
  let sources: { food: { retrievedAt: string }; groups: unknown[][][]; extra: { source: 'obf' | 'opf'; rows: unknown[]; retrievedAt: string }[] };
  try {
    const cache = options.sourceCache ?? resolve(dirname(packs[pending[0]!]!.output), '..', '..', 'artifacts/offline/source-cache');
    const regions = pending.map(index => packs[index]!.region);
    log(`Offline ${regions.join(', ')}: preparing off food export.`);
    const food = await foodExport(cache, now, options.fetcher ?? fetch);
    // The decompressed export is about 10 GB, so it is read line by line.
    let groups: unknown[][][];
    // pipeline forwards read errors, so they reject the line iterator instead of escaping as unhandled events.
    try { groups = await selectFood(regions, createInterface({ input: pipeline(createReadStream(food.path), createGunzip(), () => {}), crlfDelay: Infinity })); }
    catch (error) {
      // A truncated or unusable download must not be reused from the cache on the next run.
      await rm(`${food.path}.json`, { force: true }); await rm(food.path, { force: true });
      throw error;
    }
    const extra: { source: 'obf' | 'opf'; rows: unknown[]; retrievedAt: string }[] = [];
    if (options.includeNonfood !== false) {
      for (const source of ['obf', 'opf'] as const) {
        log(`Offline: preparing ${source} regional export.`);
        extra.push(await nonfoodRows(source, cache, now, options.fetcher ?? fetch));
      }
    }
    sources = { food, groups, extra };
  } catch (error) {
    for (const index of pending) statuses[index] = stale(index, error);
    return statuses as RefreshStatus[];
  }
  for (const [position, index] of pending.entries()) {
    const { region, output } = packs[index]!, temporary = `${output}.${crypto.randomUUID()}.tmp`;
    try {
      const pack = createSnapshot(region, sources.groups[position]!, now, sources.extra);
      pack.sources[0]!.retrievedAt = sources.food.retrievedAt;
      const content = `${JSON.stringify(pack)}\n`;
      if (Buffer.byteLength(content) > packLimits(region).bytes) throw new Error('Snapshot exceeds pack size limit');
      await mkdir(dirname(output), { recursive: true });
      await writeFile(temporary, content, { flag: 'wx' });
      await rename(temporary, output);
      log(`Offline ${region}: updated ${pack.products.length} products, ${(Buffer.byteLength(content) / 1024 / 1024).toFixed(2)} MiB, ${pack.generatedAt}.`);
      statuses[index] = 'updated';
    } catch (error) {
      await rm(temporary, { force: true });
      statuses[index] = stale(index, error);
    }
  }
  return statuses as RefreshStatus[];
}
if (import.meta.main) {
  const args = process.argv.slice(2);
  const value = (key: string) => { const index = args.indexOf(key); return index < 0 ? undefined : args[index + 1]; };
  const region = value('--region') ?? 'de-eu', directory = value('--output-dir');
  const regions = region === 'all' ? PACK_REGIONS : region.split(',');
  if (['--region', '--output', '--output-dir'].some(key => args.includes(key) && (!value(key) || value(key)!.startsWith('--'))) ||
    regions.some(item => item !== 'de-eu' && !Object.hasOwn(PACKS, item)) || new Set(regions).size !== regions.length ||
    args.includes('--output') && (directory !== undefined || regions.length > 1) || args.some((arg, index) =>
    !['--region', '--output', '--output-dir', '--force', '--strict'].includes(arg) && !['--region', '--output', '--output-dir'].includes(args[index - 1] ?? ''))) {
    throw new Error('Usage: bun scripts/offline-snapshot.ts [--region de-eu|all|PACK[,PACK…]] [--output path | --output-dir directory] [--force] [--strict]');
  }
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
    const output = (item: string) => resolve(value('--output') ?? (directory ? `${directory}/${item}.json` : item === 'de-eu' ? `${root}/data/offline/bundle.json` : `${root}/artifacts/offline/${item}.json`));
    await refreshSnapshots(regions.map(item => ({ region: item as Region, output: output(item) })), { sourceCache: resolve(root, 'artifacts/offline/source-cache'), force: args.includes('--force'), strict: args.includes('--strict') });
  } finally { await rm(lock, { recursive: true, force: true }); }
}
