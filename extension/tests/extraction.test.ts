import { describe, expect, test } from 'bun:test';
import { extractProducts, safeProductUrl, validGtin, isCurrentProductAnchor } from '../src/extraction';
import { allowBackground, isBackgroundRequest, isCheckInput, scanInput, pendingInput, inspectedInput } from '../src/protocol';
import { readImageResponse } from '../src/images';
import { endpointOrigin, parseSettings } from '../src/settings';

describe('product identity', () => {
  test('inspecting a page keeps product identity separate from supplied composition', () => {
    const title = 'adidas originals aspyre - trainers - cloud white/grey one/white - zalando';
    expect(inspectedInput({ selection: '', title, products: [] })).toEqual({ text: '', name: title });
    expect(inspectedInput({ selection: '', title, products: [{ name: 'Trainers', barcode: '4006381333931' }] })).toEqual({ text: '', name: 'Trainers', barcode: '4006381333931' });
    expect(inspectedInput({ selection: 'Obermaterial: Leder/Synthetik', title, products: [] })).toEqual({ text: 'Obermaterial: Leder/Synthetik' });
    expect(inspectedInput({ selection: 'unknown fabric', title, products: [] })).toEqual({ text: 'unknown fabric' });
  });
  test('recycled marketplace cards and removed anchors cannot retain a prior product badge', () => {
    const url = 'https://www.zalando.de/canvas-shoe';
    expect(isCurrentProductAnchor({ isConnected: true, href: url }, url, 'https://www.zalando.de/search')).toBe(true);
    expect(isCurrentProductAnchor({ isConnected: true, href: 'https://www.zalando.de/leather-shoe' }, url, 'https://www.zalando.de/search')).toBe(false);
    expect(isCurrentProductAnchor({ isConnected: false, href: url }, url, url)).toBe(false);
    expect(isCurrentProductAnchor({ isConnected: true }, url, 'https://www.zalando.de/leather-shoe')).toBe(false);
  });
  test('accepts exact GTIN checksums and rejects SKU-like numbers', () => {
    expect(validGtin('4006381333931')).toBe('4006381333931');
    expect(validGtin('4006381333932')).toBeUndefined();
    expect(validGtin(4006381333931)).toBeUndefined();
    expect(validGtin('B0001234')).toBeUndefined();
  });
  test('extracts nested product cards without assigning the brand a product barcode', () => {
    const products = extractProducts({ '@graph': [{ '@type': 'Organization', name: 'Brand', gtin13: '4006381333931' }, { '@type': 'ItemList', itemListElement: [{ item: { '@type': ['Thing', 'Product'], name: 'Shoe', gtin13: '4006381333931', url: '/shoe' } }] }] });
    expect(products).toEqual([{ name: 'Shoe', barcode: '4006381333931', url: '/shoe' }]);
  });
  test('keeps variants separate and does not guess invalid identifiers', () => {
    const products = extractProducts({ '@type': 'Product', name: 'Shoe', gtin: 'invalid', hasVariant: [{ '@type': 'Product', name: 'Leather', gtin: '4006381333931' }] });
    expect(products).toHaveLength(2);
    expect(products[0]?.barcode).toBeUndefined();
    expect(products[1]?.barcode).toBe('4006381333931');
  });
  test('refuses off-site URLs and script links', () => {
    expect(safeProductUrl('/shoe', 'https://www.zalando.de/search')).toBe('https://www.zalando.de/shoe');
    expect(safeProductUrl('https://evil.example/shoe', 'https://www.zalando.de/')).toBeUndefined();
    expect(safeProductUrl('javascript:alert(1)', 'https://www.zalando.de/')).toBeUndefined();
  });
});

describe('privacy boundaries', () => {
  test('selected barcode context-menu checks enter the same database path as pasted input', () => {
    expect(pendingInput({ text: '4006381333931', createdAt: Date.now() }).barcode).toBe('4006381333931');
    expect(pendingInput({ barcode: '4006381333931', name: 'Example', createdAt: Date.now() })).toMatchObject({ barcode: '4006381333931', name: 'Example' });
  });
  test('remote image reads enforce limits without a Content-Length header', async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(15 * 1024 * 1024 + 1)); },
      cancel() { cancelled = true; },
    });
    await expect(readImageResponse(new Response(stream, { headers: { 'Content-Type': 'image/jpeg' } }))).rejects.toThrow('too large');
    expect(cancelled).toBe(true);
    expect((await readImageResponse(new Response(new Uint8Array([1, 2]), { headers: { 'Content-Type': 'image/png' } }))).size).toBe(2);
  });
  test('an unchecked completeness box leaves photo completeness for extraction to determine', () => {
    expect(scanInput({ text: '', category: 'food', images: ['data:image/jpeg;base64,YQ=='], complete: false }).complete).toBeUndefined();
    expect(scanInput({ text: 'milk', category: 'food', images: [], complete: true }).complete).toBe(true);
  });
  test('content scripts can only request GTIN-based database checks or open the extension', () => {
    expect(isBackgroundRequest({ type: 'check', barcode: '4006381333931', images: ['photo'], token: 'secret' })).toBe(false);
    expect(isBackgroundRequest({ type: 'background-check', barcode: '4006381333931' })).toBe(true);
    expect(isBackgroundRequest({ type: 'state' })).toBe(false);
    expect(isBackgroundRequest({ type: 'background-check', barcode: 'not-a-barcode' })).toBe(false);
  });
  test('automatic lookup requires the actual opted-in origin', () => {
    expect(allowBackground('https://www.dm.de/product', ['https://www.dm.de/*'])).toBe(true);
    expect(allowBackground('https://www.dm.de.evil.example/product', ['https://www.dm.de/*'])).toBe(false);
    expect(allowBackground('https://www.dm.de/product', [])).toBe(false);
  });
  test('language follows the browser once and preserves explicit choices', () => {
    expect(parseSettings(undefined, 'de-DE').language).toBe('de');
    expect(parseSettings(undefined, 'en-GB').language).toBe('en');
    expect(parseSettings(undefined, 'sv-SE').language).toBe('en');
    expect(parseSettings({ language: 'en' }, 'de-DE').language).toBe('en');
    expect(parseSettings({ language: 'de' }, 'en-GB').language).toBe('de');
    expect(parseSettings({ language: 'invalid' }, 'en-GB').language).toBe('en');
  });
  test('removed vision preferences cannot disable automatic image support', () => {
    const settings = parseSettings({ connection: 'openai', model: 'gpt-6-astra', vision: false });
    expect(settings).not.toHaveProperty('vision');
    expect(settings.model).toBe('gpt-6-astra');
    expect(parseSettings(undefined).connection).toBe('chatgpt');
  });
  test('settings never persist injected credentials and default to no background sites', () => {
    const settings = parseSettings({ token: 'secret', stores: ['dm', 'all'], language: 'en', connection: 'unknown' });
    expect(JSON.stringify(settings)).not.toContain('secret');
    expect(settings.stores).toEqual(['dm']);
    expect(parseSettings(undefined).stores).toEqual([]);
  });
  test('remote API credentials require TLS except explicit loopback', () => {
    expect(endpointOrigin('https://api.openai.com/v1')).toBe('https://api.openai.com/*');
    expect(endpointOrigin('http://localhost:11434/v1')).toBe('http://localhost/*');
    for (const url of ['http://api.example/v1', 'https://user:password@api.example/v1', 'https://api.example/v1?key=secret', 'file:///tmp/file']) expect(() => endpointOrigin(url)).toThrow();
  });
  test('check messages reject raw remote images, excessive photos, and invalid flags', () => {
    expect(isCheckInput({ text: 'Ingredients: milk', complete: false, images: ['data:image/jpeg;base64,YQ=='] })).toBe(true);
    expect(isCheckInput({ images: ['https://private.example/photo.jpg'] })).toBe(false);
    expect(isCheckInput({ images: Array(4).fill('data:image/jpeg;base64,YQ==') })).toBe(false);
    expect(isCheckInput({ complete: 'true' })).toBe(false);
    expect(isCheckInput({ category: 'definitely-vegan' })).toBe(false);
  });
});
