import { analyzeText, countryCode, DATABASES, normalizeBarcode } from '../../packages/core/src/index';
import { applyAIEvidence } from '../../packages/core/src/ai-evidence';
import { readBoundedText } from '../../packages/core/src/http';
import { databaseCountryWarning } from '../../packages/core/src/market';
import type { AIExtraction, CheckInput, CheckResult } from '../../packages/core/src/types';

const lastRequests = new Map<string, number>();
const normalize = (value: string) => value.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
const text = (value: unknown) => typeof value === 'string' ? value.trim() : '';
function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function countries(product: Record<string, unknown>): string[] {
  const tags = Array.isArray(product.countries_tags) ? product.countries_tags.filter((value): value is string => typeof value === 'string' && Boolean(value.trim())) : [];
  return tags.length ? tags : text(product.countries).split(/[,;|]/).map(value => value.trim()).filter(Boolean);
}

/** Require a unique packaging match; a name match never establishes an exact barcode or complete label. */
export async function identifiedProduct(extraction: AIExtraction, input: CheckInput, signal?: AbortSignal): Promise<CheckResult | undefined> {
  const sourceID = ({ food: 'off', drink: 'off', cosmetics: 'obf', clothing: 'opf', shoes: 'opf', household: 'opf' } as Record<string, string>)[extraction.category];
  const source = DATABASES.find(db => db.id === sourceID);
  const packaging = extraction.packaging;
  const name = text(extraction.name), brand = text(extraction.brand);
  if (!source || !packaging || !name || !brand || !text(packaging.quantity) || normalizeBarcode(input.barcode ?? '') || normalizeBarcode(extraction.barcode ?? '')) return;
  const language = (globalThis as typeof globalThis & { nativeLanguage(value: string): string }).nativeLanguage(packaging.language ?? '');
  const ignored = language === 'sv' ? 'med' : language === 'en' ? 'with' : '';
  const stripBrand = (value: string) => {
    let stripped = normalize(value), prefix = normalize(brand);
    while (stripped === prefix || stripped.startsWith(prefix + ' ')) stripped = stripped.slice(prefix.length).trim();
    return stripped;
  };
  const words = (value: string) => stripBrand(value).split(' ').filter(word => word && word !== ignored).sort();
  const expectedWords = words(name);
  const query = `${brand} ${stripBrand(name)}`.trim();
  if (!expectedWords.length || query.length < 2 || query.length > 200) return;
  const packagingCountry = packaging.country ? countryCode(packaging.country) : undefined;
  if (packaging.country && !packagingCountry) return;
  const selectedCountry = input.market ? countryCode(input.market) : undefined;
  const expectedCountry = packagingCountry ?? selectedCountry;
  // Recovery must not add another market's composition to a manually selected
  // country or to a fallback selected because the country clues conflict.
  if (packagingCountry && selectedCountry && selectedCountry !== packagingCountry) return;
  // Only searches that actually start consume a slot; cancelled waiters reserve nothing.
  while (true) {
    signal?.throwIfAborted();
    const delay = 6100 - (Date.now() - (lastRequests.get(source.id) ?? -Infinity));
    if (delay <= 0) break;
    await new Promise<void>((resolve, reject) => {
      const timer = AbortSignal.timeout(delay);
      const finished = () => {
        timer.removeEventListener('abort', finished);
        signal?.removeEventListener('abort', finished);
        if (signal?.aborted) reject(new Error('Cancelled')); else resolve();
      };
      timer.addEventListener('abort', finished);
      signal?.addEventListener('abort', finished);
    });
  }
  lastRequests.set(source.id, Date.now());
  const url = new URL('/cgi/search.pl', source.origin);
  for (const [key, value] of Object.entries({ search_terms: query, search_simple: '1', action: 'process', json: '1', page: '1', page_size: '20', lc: language,
    fields: `code,product_name,product_name_${language},brands,ingredients_text,ingredients_text_${language},countries,countries_tags,quantity,last_modified_t` })) url.searchParams.set(key, value);
  const response = await fetch(url.href, { credentials: 'omit', redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(8000)]) : AbortSignal.timeout(8000) });
  if (!response.ok) return;
  const envelope = record(JSON.parse(await readBoundedText(response, 1_048_576)));
  const products = envelope?.products;
  if (!Array.isArray(products) || products.length > 20 || typeof envelope?.count === 'number' && envelope.count > 20 || products.length === 20 && envelope?.count !== 20) return;
  const localized = (product: Record<string, unknown>, key: string) => text(product[`${key}_${language}`]) || text(product[key]);
  const candidates = products.map(record).filter((product): product is Record<string, unknown> => {
    if (!product) return false;
    const markets = countries(product);
    return /^\d{4,30}$/.test(text(product.code)) && Boolean(localized(product, 'ingredients_text')) &&
      normalize(text(product.brands)) === normalize(brand) && words(localized(product, 'product_name')).join(' ') === expectedWords.join(' ') &&
      normalize(text(product.quantity)).replace(/\s/g, '') === normalize(packaging.quantity!).replace(/\s/g, '') &&
      words(packaging.variant ?? '').every(word => expectedWords.includes(word)) &&
      (!expectedCountry || !packagingCountry && input.autoMarket !== false && !markets.length || markets.some(market => countryCode(market) === expectedCountry));
  });
  if (candidates.length !== 1) return;
  const product = candidates[0]!;
  const composition = localized(product, 'ingredients_text');
  if (composition.length > 20_000) return;
  const productInput: CheckInput = { name, brand, text: composition, category: extraction.category, complete: false, locale: input.locale, market: input.market };
  let result = analyzeText(productInput);
  const evidenceID = `${source.id}:${text(product.code)}`;
  result.evidence = [{ id: evidenceID, kind: 'database', title: source.name, excerpt: composition,
    url: `${source.origin}/product/${text(product.code)}`, retrievedAt: result.checkedAt, license: 'ODbL-1.0 (database); DBCL-1.0 (contents)' }];
  result.findings = result.findings.map(finding => ({ ...finding, evidenceId: evidenceID }));
  result.identity.match = 'unconfirmed';
  result.warnings.push(input.locale === 'de' ? 'Gemeinschaftlich gepflegter Datensatz; Markt, Rezeptur und Aktualität prüfen.' : 'Community-maintained record; check market, recipe and freshness.');
  const countryWarning = databaseCountryWarning(result.identity.market, countries(product), input.locale);
  if (countryWarning) result.warnings.push(countryWarning);
  // Preserve the full database split; partial model parsing cannot remove an ingredient.
  result = applyAIEvidence(result, productInput, { ...extraction, text: composition, ingredients: undefined }, false);
  result.evidence = result.evidence.map(item => item.id === 'ai-assessment' ? { ...item, id: `${evidenceID}-assessment` } : item);
  result.findings = result.findings.map(item => item.evidenceId === 'ai-assessment' ? { ...item, evidenceId: `${evidenceID}-assessment` } : item);
  return result;
}
