import { normalizeBarcode } from './barcode';
import { readBoundedText } from './http';
import { compositionTerms, parseSourceIngredients, safeSourceUrl } from './analyze';
import type { AIExtraction, CheckInput } from './types';

const endpoint = 'https://api.matspar.se/slug';
const maxResponseBytes = 256_000;
type JsonObject = Record<string, unknown>;
export interface MatsparComposition {
  url: string;
  text: string;
  productName: string;
  brand: string;
  quantity: string;
}
function object(value: unknown): value is JsonObject { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function text(value: unknown): string { return typeof value === 'string' ? value.trim() : ''; }
function identity(value: string): string { return value.normalize('NFKC').toLocaleLowerCase('sv-SE').replace(/\s+/g, ' ').trim(); }
function words(value: string, brand: string): string[] {
  const normalized = identity(value);
  const prefix = `${identity(brand)} `;
  return (normalized.startsWith(prefix) ? normalized.slice(prefix.length) : normalized)
    .split(/\s+/).filter(word => word && word !== 'med').sort();
}
function quantity(value: string): string { return identity(value).replace(/\s+/g, ''); }
function matches(product: JsonObject, name: string, brand: string, quantityValue: string, variant: string): boolean {
  const productName = text(product.name);
  return identity(text(product.brand)) === identity(brand) && words(productName, brand).join(' ') === words(name, brand).join(' ') &&
    quantity(text(product.weight_pretty)) === quantity(quantityValue) && words(variant, brand).every(word => words(productName, brand).includes(word));
}
function swedishIdentity(extraction: AIExtraction, input: CheckInput): { name: string; brand: string; quantity: string; variant: string } | undefined {
  const packaging = extraction.packaging;
  if (!packaging || !['food', 'drink'].includes(extraction.category) ||
    !['sv', 'swedish', 'svenska'].includes(identity(packaging.language ?? '')) ||
    packaging.country && !['se', 'sweden', 'sverige'].includes(identity(packaging.country)) ||
    normalizeBarcode(input.barcode ?? extraction.barcode ?? '')) return undefined;
  const result = { name: text(extraction.name), brand: text(extraction.brand), quantity: text(packaging.quantity), variant: text(packaging.variant) };
  return result.name && result.brand && result.quantity ? result : undefined;
}
async function boundedJson(response: Response): Promise<unknown> {
  if (!response.ok || response.redirected) return undefined;
  try { return JSON.parse(await readBoundedText(response, maxResponseBytes)) as unknown; } catch { return undefined; }
}
async function page(fetcher: typeof fetch, slug: string, query: { q?: string }, type: string, signal?: AbortSignal): Promise<JsonObject | undefined> {
  const timeout = AbortSignal.timeout(10_000);
  const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const response = await fetcher(endpoint, { method: 'POST', credentials: 'omit', redirect: 'error', signal: requestSignal,
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ slug, query }) });
  const body = await boundedJson(response);
  if (!object(body) || body.type !== type || !object(body.payload)) return undefined;
  return body.payload;
}

function coversComposition(sourceText: string, value: unknown): string[] | undefined {
  const parsed = parseSourceIngredients(sourceText, value);
  if (!parsed) return undefined;
  const heading = /(?:^|\n)\s*(?:ingredients|ingredienser|zutaten|materials|material|composition)\s*:\s*/i.exec(sourceText);
  let body = heading ? sourceText.slice(heading.index + heading[0].length) : sourceText;
  const precaution = /\b(?:may contain|kan innehålla spår av|kann spuren von|spuren von)\b/i.exec(body);
  if (precaution) body = body.slice(0, precaution.index);
  body = body.replace(/\s+\*Ursprung: Se till vänster\.?\s*$/i, '');
  const terms = compositionTerms(body);
  const escaped = (term: string) => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const covered = terms.every(term => {
    let remaining = term;
    for (const ingredient of [...parsed].sort((a, b) => b.length - a.length)) {
      remaining = remaining.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escaped(ingredient)}(?![\\p{L}\\p{N}])`, 'giu'), '');
    }
    return !/[\p{L}\p{N}]/u.test(remaining);
  });
  return covered ? parsed : undefined;
}

/** Fetch a public Swedish retailer composition after exact identity and package matching. */
export async function lookupMatspar(extraction: AIExtraction, input: CheckInput, fetcher: typeof fetch = globalThis.fetch, signal?: AbortSignal): Promise<MatsparComposition | undefined> {
  const match = swedishIdentity(extraction, input);
  if (!match) return undefined;
  const category = await page(fetcher, '/kategori', { q: `${match.brand} ${match.name}`.slice(0, 601) }, 'category', signal);
  const products = category?.products;
  if (!Array.isArray(products) || products.length > 100) return undefined;
  const candidates = products.filter(object).filter(product => matches(product, match.name, match.brand, match.quantity, match.variant));
  const candidate = candidates.length === 1 ? candidates[0] : undefined;
  const slug = candidate && text(candidate.slug);
  if (!slug || !/^produkt\/[a-z0-9-]{1,300}$/.test(slug)) return undefined;
  const product = await page(fetcher, `/${slug}`, {}, 'product', signal);
  if (!product || text(product.slug) !== slug || !matches(product, match.name, match.brand, match.quantity, match.variant)) return undefined;
  const composition = text(product.ingredients);
  const productName = text(product.name);
  const productBrand = text(product.brand);
  const url = safeSourceUrl(`https://www.matspar.se/${slug}`);
  if (!composition || composition.length > 20_000 || !productName || !productBrand || !url) return undefined;
  return { url, text: composition, productName, brand: productBrand, quantity: text(product.weight_pretty) };
}

/** Only grammatical and redundant-brand variations can share the fetched product identity. */
export function matchesMatsparIdentity(extraction: AIExtraction, original: AIExtraction): boolean {
  const brand = text(original.brand);
  return Boolean(brand && identity(text(extraction.brand)) === identity(brand) &&
    words(text(extraction.name), brand).join(' ') === words(text(original.name), brand).join(' '));
}

/** Keep the fetched record as researched evidence, independent of AI transcription and completeness. */
export function retainMatsparComposition(extraction: AIExtraction, catalogue: MatsparComposition): AIExtraction {
  const title = `Matspar: ${catalogue.productName}`;
  const sources = new Map((extraction.research?.sources ?? []).map(source => [source.url, source]));
  const matchedSource = { url: catalogue.url, title };
  sources.set(catalogue.url, matchedSource);
  const candidates = [
    ...(extraction.webCompositions ?? []).filter(item => item.url === catalogue.url).map(item => item.ingredients),
    extraction.ingredientAssessments?.map(item => item.term),
  ];
  const ingredients = candidates.map(candidate => coversComposition(catalogue.text, candidate)).find(Boolean);
  const ingredientAssessments = ingredients ? extraction.ingredientAssessments : extraction.ingredientAssessments?.filter(assessment =>
    !parseSourceIngredients(catalogue.text, [assessment.term]));
  const composition = { url: catalogue.url, text: catalogue.text, ...(ingredients ? { ingredients } : {}), complete: true as const,
    sourceType: 'retailer' as const, productName: extraction.name ?? catalogue.productName, brand: extraction.brand ?? catalogue.brand };
  const compositions = [composition, ...(extraction.webCompositions ?? []).filter(item => item.url !== catalogue.url)].slice(0, 3);
  const webClaims = (extraction.webClaims ?? []).filter(item => item.url !== catalogue.url);
  const contact = extraction.contact?.sourceUrl === catalogue.url || extraction.contact?.url === catalogue.url ? undefined : extraction.contact;
  const companyAssessment = extraction.companyAssessment?.ownershipSourceUrl === catalogue.url || extraction.companyAssessment?.sources.some(source => source.url === catalogue.url)
    ? undefined : extraction.companyAssessment;
  return { ...extraction, ...(ingredientAssessments ? { ingredientAssessments } : { ingredientAssessments: undefined }), webClaims, webCompositions: compositions,
    ...(contact ? { contact } : { contact: undefined }), ...(companyAssessment ? { companyAssessment } : { companyAssessment: undefined }),
    research: { searched: true, sources: [matchedSource, ...[...sources.values()].filter(source => source.url !== catalogue.url)].slice(0, 50) } };
}
