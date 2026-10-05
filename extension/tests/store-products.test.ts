import { describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { discoverStoreProducts, isCurrentProductBinding } from '../src/store-products';

function documentOf(html: string): Document {
  const window = new Window();
  window.document.body.innerHTML = html;
  return window.document as unknown as Document;
}
const fixture = (name: string) => Bun.file(new URL(`fixtures/stores/${name}.html`, import.meta.url)).text();

describe('store DOM discovery', () => {
  test('Amazon search results without GTIN expose explicit checks, never ASIN barcodes', async () => {
    const document = documentOf(await fixture('amazon'));
    const products = discoverStoreProducts(document, 'https://www.amazon.de/s?k=oat');
    expect(products.map(item => item.product)).toEqual([
      { name: 'Example Oat Drink 1L', url: 'https://www.amazon.de/dp/B0ABC12345' },
      { name: 'Example Milk Drink 1L', url: 'https://www.amazon.de/dp/B0DEF67890' },
    ]);
  });
  test('Amazon product pages without JSON-LD expose the current heading', () => {
    const document = documentOf('<h1><span id="productTitle">Example Oat Drink 1L</span></h1>');
    const products = discoverStoreProducts(document, 'https://www.amazon.de/example/dp/B0ABC12345?th=1');
    expect(products).toHaveLength(1);
    expect(products[0]?.anchor.id).toBe('productTitle');
    expect(products[0]?.product.barcode).toBeUndefined();
  });
  test('current dm product-ID URLs expose explicit checks without treating IDs as GTIN', async () => {
    const products = discoverStoreProducts(documentOf(await fixture('dm')), 'https://www.dm.de/search?query=drink');
    expect(products.find(item => item.product.name === 'Haferdrink Barista, 1 l')?.product).toEqual({ name: 'Haferdrink Barista, 1 l', url: 'https://www.dm.de/p/d/1697279/dmbio-haferdrink-barista' });
  });
  test('dm product links supply checksummed GTIN and collapse duplicate links', async () => {
    const products = discoverStoreProducts(documentOf(await fixture('dm')), 'https://www.dm.de/search?query=drink');
    expect(products[0]?.product).toEqual({ name: 'Example plant drink', barcode: '4006381333931', url: 'https://www.dm.de/example-plant-drink-p4006381333931.html' });
  });
});

describe('current dm and changing store identities', () => {
  test('live dm detail heading separates brand and ignores rating-only Product metadata', async () => {
    const document = documentOf(await fixture('dm-product'));
    const url = 'https://www.dm.de/p/d/1697279/dmbio-haferdrink-barista';
    expect(discoverStoreProducts(document, url).map(binding => binding.product)).toEqual([{ name: 'Haferdrink Barista, 1 l', brand: 'dmBio', barcode: '4070765022841', url }]);
  });
  test('Amazon marketplaces share discovery without matching lookalike domains', async () => {
    for (const domain of ['www.amazon.se', 'www.amazon.com', 'www.amazon.co.uk']) {
      expect(discoverStoreProducts(documentOf(await fixture('amazon')), `https://${domain}/s?k=oat`)[0]?.product.url).toBe(`https://${domain}/dp/B0ABC12345`);
    }
    expect(discoverStoreProducts(documentOf(await fixture('amazon')), 'https://www.amazon.de.evil.example/s?k=oat')).toEqual([]);
  });
  test('live dm tiles bind brand and checksum GTIN to descriptive links, not image links', async () => {
    const document = documentOf(await fixture('dm-current'));
    const bindings = discoverStoreProducts(document, 'https://www.dm.de/search?query=hafer');
    expect(bindings).toHaveLength(1);
    expect(bindings[0]?.product).toEqual({ name: 'Haferdrink Barista, 1 l', brand: 'dmBio', barcode: '4070765022841', url: 'https://www.dm.de/p/d/1697279/dmbio-haferdrink-barista' });
    expect(bindings[0]?.anchor.closest('[data-dmid="product-description"]')).not.toBeNull();
    const binding = bindings[0]!;
    expect(isCurrentProductBinding(binding, 'https://www.dm.de/search?query=hafer')).toBe(true);
    document.querySelector('[data-dmid="product-tile"]')!.setAttribute('data-gtin', '4006381333931');
    expect(isCurrentProductBinding(binding, 'https://www.dm.de/search?query=hafer')).toBe(false);
  });
  test('Amazon recycled cards invalidate immediately when ASIN, title or href changes', async () => {
    for (const mutate of [
      (document: Document) => document.querySelector('[data-asin]')!.setAttribute('data-asin', 'B0NEW12345'),
      (document: Document) => { document.querySelector('h2')!.textContent = 'Replacement product'; },
      (document: Document) => document.querySelector('a')!.setAttribute('href', '/dp/B0NEW12345'),
      (document: Document) => document.querySelector('[data-asin]')!.remove(),
    ]) {
      const document = documentOf(await fixture('amazon'));
      const binding = discoverStoreProducts(document, 'https://www.amazon.de/s?k=oat')[0]!;
      expect(isCurrentProductBinding(binding, 'https://www.amazon.de/s?k=oat')).toBe(true);
      mutate(document);
      expect(isCurrentProductBinding(binding, 'https://www.amazon.de/s?k=oat')).toBe(false);
    }
  });
  test('Amazon selected variation invalidates a heading even before the URL changes', () => {
    const document = documentOf('<input id="ASIN" value="B0ABC12345"><h1 id="productTitle">Product</h1>');
    const url = 'https://www.amazon.de/dp/B0ABC12345';
    const binding = discoverStoreProducts(document, url)[0]!;
    document.querySelector('#ASIN')!.setAttribute('value', 'B0NEW12345');
    expect(isCurrentProductBinding(binding, url)).toBe(false);
    expect(discoverStoreProducts(document, url)[0]?.product.url).toBe('https://www.amazon.de/dp/B0NEW12345');
  });
  test('dm numeric internal IDs and invalid check digits never become barcodes', () => {
    const document = documentOf('<div data-dmid="product-tile" data-gtin="4070765022842" data-dan="4006381333931"><div data-dmid="product-description"><a href="/p/d/4006381333931/example">Example</a></div></div>');
    expect(discoverStoreProducts(document, 'https://www.dm.de/search')[0]?.product.barcode).toBeUndefined();
  });
});

describe('structured product bindings', () => {
  const jsonld = (product: unknown) => `<script type="application/ld+json">${JSON.stringify(product)}</script>`;
  const gtin = '4006381333931';
  test('resolves @id fragments and offers URLs without requiring Product.url', () => {
    for (const urlField of [{ '@id': '/plant#product' }, { offers: { url: '/plant' } }]) {
      const document = documentOf('<a href="/plant">Plant drink</a>' + jsonld({ '@type': 'Product', name: 'Plant drink', gtin13: gtin, ...urlField }));
      expect(discoverStoreProducts(document, 'https://www.example.test/search')[0]?.product).toEqual({ name: 'Plant drink', barcode: gtin, url: 'https://www.example.test/plant' });
    }
  });
  test('URL-less Product binds only to matching product heading, never unrelated search heading', () => {
    const metadata = jsonld({ '@type': 'Product', name: 'Plant drink', gtin13: gtin });
    expect(discoverStoreProducts(documentOf('<h1>Plant drink</h1>' + metadata), 'https://www.example.test/plant')[0]?.product.barcode).toBe(gtin);
    expect(discoverStoreProducts(documentOf('<h1>Search results</h1>' + metadata), 'https://www.example.test/search')).toEqual([]);
  });
  test('conflicting variants on a shared URL have no barcode and metadata changes invalidate old binding', () => {
    const document = documentOf('<h1>Plant drink</h1>' + jsonld({ '@type': 'Product', name: 'Plant drink', url: '/plant', gtin13: gtin }));
    const url = 'https://www.example.test/plant';
    const binding = discoverStoreProducts(document, url)[0]!;
    document.querySelector('script')!.textContent = JSON.stringify([{ '@type': 'Product', name: 'Plant drink', url: '/plant', gtin13: gtin }, { '@type': 'Product', name: 'Milk drink', url: '/plant', gtin13: '4070765022841' }]);
    expect(isCurrentProductBinding(binding, url)).toBe(false);
    expect(discoverStoreProducts(document, url)[0]?.product.barcode).toBeUndefined();
  });
  test('changed heading cannot borrow stale metadata barcode', () => {
    const document = documentOf('<h1>Plant drink</h1>' + jsonld({ '@type': 'Product', name: 'Plant drink', url: '/plant', gtin13: gtin }));
    document.querySelector('h1')!.textContent = 'Milk drink';
    expect(discoverStoreProducts(document, 'https://www.example.test/plant')[0]?.product.barcode).toBeUndefined();
  });
  test('rejects offsite product URLs, hidden links, malformed metadata and excessive candidates', () => {
    const document = documentOf('<script type="application/ld+json">invalid</script><a href="https://evil.example/product">Product</a>' + jsonld({ '@type': 'Product', name: 'Product', gtin13: gtin, url: 'https://evil.example/product' }));
    expect(discoverStoreProducts(document, 'https://www.dm.de/search')).toEqual([]);
    const many = documentOf(Array.from({ length: 40 }, (_, index) => `<a href="/p/d/${index}/product">Product ${index}</a>`).join('') + '<a hidden href="/p/d/200/hidden">Hidden product</a>');
    expect(discoverStoreProducts(many, 'https://www.dm.de/search')).toHaveLength(20);
    expect(discoverStoreProducts(documentOf('<a hidden href="/p/d/200/hidden">Hidden product</a>'), 'https://www.dm.de/search')).toEqual([]);
  });
});
