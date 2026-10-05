import { AMAZON_MARKETS } from './settings';
import { extractProducts, safeProductUrl, validGtin, type PageProduct } from './extraction';

export interface ProductBinding { anchor: Element; product: PageProduct; identity: string; }
const limit = 20;
const clean = (value: string | null | undefined): string => (value ?? '').replace(/\s+/g, ' ').trim().slice(0, 500);
const asin = (value: string | null): string | undefined => value && /^[A-Z0-9]{10}$/.test(value) ? value : undefined;
const amazonHost = (host: string): boolean => Object.keys(AMAZON_MARKETS).some(domain => host === domain || host.endsWith(`.${domain}`));
const dmHost = (host: string): boolean => host === 'www.dm.de' || host === 'dm.de';
const dmProductPath = (path: string): boolean => /-p\d{8,14}\.html$/.test(path) || /^\/p\/d\/\d+\/[^/]+\/?$/.test(path);

/** Tracking links are not product variants. Other stores retain query parameters conservatively. */
function productUrl(value: string | undefined, pageUrl: string): string | undefined {
  const safe = safeProductUrl(value, pageUrl);
  if (!safe) return;
  const url = new URL(safe);
  url.hash = '';
  if (amazonHost(url.hostname)) {
    const id = asin(url.pathname.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})(?:\/|$)/)?.[1] ?? null);
    if (id) return `${url.origin}/dp/${id}`;
  }
  if (dmHost(url.hostname) && dmProductPath(url.pathname)) url.search = '';
  return url.href;
}
function nameOf(anchor: Element): string {
  return clean(anchor.querySelector('h1,h2,h3,[data-testid="product-title"]')?.textContent)
    || clean(anchor.getAttribute('aria-label')) || clean(anchor.querySelector('img')?.getAttribute('alt')) || clean(anchor.textContent);
}
function usable(anchor: Element): boolean {
  return !anchor.closest('[hidden],[aria-hidden="true"],script,template,nav,footer');
}

/** Only DOM/structured data is read here. Discovery performs no network or AI request. */
export function discoverStoreProducts(document: Document, pageUrl: string): ProductBinding[] {
  let page: URL;
  try { page = new URL(pageUrl); } catch { return []; }
  if (!/^https?:$/.test(page.protocol)) return [];
  const structured: PageProduct[] = [];
  let scripts = 0;
  for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
    if (++scripts > 20 || structured.length >= 100) break;
    const text = script.textContent ?? '';
    if (text.length > 300_000) continue;
    try { structured.push(...extractProducts(JSON.parse(text)).slice(0, 100 - structured.length)); } catch { /* Malformed page metadata is ignored. */ }
  }
  const candidates: { anchor: Element; product: PageProduct; variant?: string }[] = [];
  const add = (anchor: Element | null, product: PageProduct, variant?: string) => {
    if (!anchor || !usable(anchor) || !product.name || !product.url || candidates.length >= 100) return;
    candidates.push({ anchor, product, variant });
  };
  if (amazonHost(page.hostname)) {
    const heading = document.querySelector('#productTitle');
    const selected = asin(document.querySelector('input#ASIN')?.getAttribute('value') ?? null);
    const currentUrl = selected ? `${page.origin}/dp/${selected}` : productUrl(pageUrl, pageUrl);
    if (heading && currentUrl && /\/dp\/[A-Z0-9]{10}$/.test(currentUrl)) add(heading, { name: clean(heading.textContent), url: currentUrl }, selected);
    let count = 0;
    for (const card of document.querySelectorAll('[data-asin]')) {
      if (++count > 200) break;
      const id = asin(card.getAttribute('data-asin'));
      if (!id) continue;
      const url = `${page.origin}/dp/${id}`;
      const links = Array.from(card.querySelectorAll('a[href]')).slice(0, 20);
      const link = links.find(link => productUrl(link.getAttribute('href') ?? undefined, pageUrl) === url);
      if (!link) continue;
      const title = card.querySelector('h2');
      const anchor = title ?? link;
      add(anchor, { name: clean(title?.textContent) || nameOf(link), url }, id);
    }
  }
  const pageProductUrl = productUrl(pageUrl, pageUrl);
  const heading = document.querySelector('main h1, h1');
  if (dmHost(page.hostname)) {
    const barcode = validGtin(page.pathname.match(/-p(\d{8,14})\.html$/)?.[1]);
    if (dmProductPath(page.pathname) && heading && pageProductUrl) {
      const title = heading.cloneNode(true) as Element;
      const brandLink = title.querySelector('a[href^="/marken/"]');
      const brand = clean(brandLink?.textContent);
      brandLink?.remove();
      add(heading, { name: clean(title.textContent), url: pageProductUrl, ...(barcode ? { barcode } : {}), ...(brand ? { brand } : {}) });
    }
  }
  if (dmHost(page.hostname)) {
    let count = 0;
    for (const tile of document.querySelectorAll('[data-dmid="product-tile"]')) {
      if (++count > 200) break;
      const link = tile.querySelector('[data-dmid="product-description"] a[href]');
      const url = productUrl(link?.getAttribute('href') ?? undefined, pageUrl);
      if (!link || !url || !dmProductPath(new URL(url).pathname)) continue;
      const barcode = validGtin(tile.getAttribute('data-gtin'));
      const brand = clean(tile.querySelector('[data-dmid="product-brand"]')?.textContent);
      add(link, { name: clean(link.textContent), url, ...(barcode ? { barcode } : {}), ...(brand ? { brand } : {}) }, tile.getAttribute('data-dan') ?? undefined);
    }
  }
  // Read only a bounded set of same-origin product links; no SKU/ASIN is ever used as a GTIN.
  const links: Element[] = [];
  for (const link of document.querySelectorAll('a[href]')) {
    if (links.length >= 1000) break;
    links.push(link);
    if (!dmHost(page.hostname)) continue;
    const url = productUrl(link.getAttribute('href') ?? undefined, pageUrl);
    const digits = url && new URL(url).pathname.match(/-p(\d{8,14})\.html$/)?.[1];
    if (!url || !dmProductPath(new URL(url).pathname)) continue;
    const barcode = validGtin(digits);
    add(link.querySelector('h2,h3') ?? link, { name: nameOf(link), url, ...(barcode ? { barcode } : {}) });
  }
  const groups = new Map<string, PageProduct[]>();
  for (const item of structured) {
    if (!item.name && !item.barcode) continue; // Rating-only Product nodes describe no additional variant.
    // URL-less metadata belongs to a detail heading only when its name matches; never guess a listing item.
    const url = productUrl(item.url, pageUrl) ?? (!item.url && heading && clean(item.name).toLocaleLowerCase() === clean(heading.textContent).toLocaleLowerCase() ? pageProductUrl : undefined);
    if (url) groups.set(url, [...(groups.get(url) ?? []), item]);
  }
  for (const [url, items] of groups) {
    const item = items[0];
    if (!item) continue;
    const anchor = url === pageProductUrl ? heading : links.find(link => productUrl(link.getAttribute('href') ?? undefined, pageUrl) === url);
    if (anchor) add(anchor, { name: nameOf(anchor) || item.name, url });
  }
  const result: ProductBinding[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const product = { ...candidate.product };
    const url = product.url!;
    if (seen.has(url)) continue;
    seen.add(url);
    const options = groups.get(url) ?? [];
    const matching = options.filter(item => clean(item.name).toLocaleLowerCase() === product.name.toLocaleLowerCase());
    const variantNames = new Set(options.map(item => clean(item.name).toLocaleLowerCase()));
    const barcodes = new Set([product.barcode, ...matching.map(item => item.barcode)].filter((code): code is string => !!code));
    // Conflicting variants sharing one URL must remain explicit checks without a database badge.
    if (barcodes.size === 1 && variantNames.size <= 1 && (!options.length || matching.length === options.length)) product.barcode = [...barcodes][0];
    else delete product.barcode;
    const brands = new Set(matching.map(item => item.brand).filter((brand): brand is string => !!brand));
    if (!product.brand && brands.size === 1) product.brand = [...brands][0];
    const identity = JSON.stringify([url, product.name, product.brand ?? '', product.barcode ?? '', candidate.variant ?? '', options.map(item => [item.name, item.barcode ?? ''])]);
    result.push({ anchor: candidate.anchor, product, identity });
    if (result.length >= limit) break;
  }
  return result;
}

/** Re-check recycled cards, selected variants and metadata before displaying any asynchronous result. */
export function isCurrentProductBinding(binding: ProductBinding, pageUrl: string): boolean {
  return binding.anchor.isConnected && discoverStoreProducts(binding.anchor.ownerDocument, pageUrl).some(current => current.anchor === binding.anchor && current.identity === binding.identity);
}
