export interface PageProduct { name: string; brand?: string; barcode?: string; url?: string; }
/** A recycled marketplace card must not retain another product's result. */
export function isCurrentProductAnchor(anchor: { isConnected: boolean; href?: string }, expectedUrl: string, pageUrl: string): boolean {
  return anchor.isConnected && (anchor.href ?? pageUrl) === expectedUrl;
}
function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
export function validGtin(value: unknown): string | undefined {
  if (typeof value !== 'string' || !/^(\d{8}|\d{12}|\d{13}|\d{14})$/.test(value)) return;
  const digits = [...value].map(Number);
  const check = digits.pop();
  const sum = digits.reverse().reduce((total, n, i) => total + n * (i % 2 === 0 ? 3 : 1), 0);
  return (10 - sum % 10) % 10 === check ? value : undefined;
}
export function extractProducts(json: unknown): PageProduct[] {
  const result: PageProduct[] = [];
  const seen = new Set<string>();
  function visit(value: unknown, depth: number): void {
    if (depth > 12 || result.length >= 50) return;
    if (Array.isArray(value)) { for (const item of value.slice(0, 100)) visit(item, depth + 1); return; }
    if (!record(value)) return;
    const type = value['@type'];
    if (type === 'Product' || (Array.isArray(type) && type.includes('Product'))) {
      const barcode = [value.gtin, value.gtin8, value.gtin12, value.gtin13, value.gtin14].map(validGtin).find(Boolean);
      const name = typeof value.name === 'string' ? value.name.slice(0, 500) : '';
      const offers = Array.isArray(value.offers) ? value.offers.slice(0, 20) : [value.offers];
      const offerUrls = [...new Set(offers.filter(record).map(offer => offer.url).filter((url): url is string => typeof url === 'string'))];
      const id = typeof value['@id'] === 'string' && /^(?:https?:|[/.#])/.test(value['@id']) ? value['@id'] : undefined;
      const url = typeof value.url === 'string' ? value.url : id ?? (offerUrls.length === 1 ? offerUrls[0] : undefined);
      const brandValue = typeof value.brand === 'string' ? value.brand : record(value.brand) ? value.brand.name : undefined;
      const brand = typeof brandValue === 'string' ? brandValue.slice(0, 300).trim() : '';
      const key = `${barcode ?? ''}:${url ?? ''}:${name}:${brand}`;
      if (!seen.has(key)) { seen.add(key); result.push({ name, barcode, url, ...(brand ? { brand } : {}) }); }
    }
    for (const key of ['@graph', 'itemListElement', 'item', 'mainEntity', 'hasVariant']) if (key in value) visit(value[key], depth + 1);
  }
  visit(json, 0);
  return result;
}
export function safeProductUrl(value: string | undefined, base: string): string | undefined {
  if (!value) return;
  try { const url = new URL(value, base); return /^https?:$/.test(url.protocol) && !url.username && !url.password && url.origin === new URL(base).origin ? url.href : undefined; } catch { return; }
}
