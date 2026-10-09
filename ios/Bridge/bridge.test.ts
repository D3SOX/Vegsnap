import { describe, expect, test } from 'bun:test';
import bundled from '../../data/offline/bundle.json';
import { readFile } from 'node:fs/promises';
import { createContext, runInContext } from 'node:vm';
import type { CheckResult } from '../../packages/core/src/types';

const build = await Bun.build({ entrypoints: [new URL('entry.ts', import.meta.url).pathname], target: 'browser', format: 'iife' });
if (!build.success) throw new AggregateError(build.logs);
const bundle = await build.outputs[0].text();
const runtime = await readFile(new URL('runtime.js', import.meta.url), 'utf8');
function harness(response: (url: string, body?: string) => { status: number; body: unknown } = () => ({ status: 404, body: {} })) {
  const calls: { url: string; options: { method: string; body?: string; chatGPT?: boolean } }[] = [];
  const completions = new Map<string, { resolve: (result: CheckResult) => void; reject: (error: Error) => void }>();
  const context = createContext({
    nativeUUID: () => crypto.randomUUID(), nativeByteCount: (value: string) => Buffer.byteLength(value),
    nativeURL: (value: string, base: string) => { try { const u = new URL(value, base || undefined); return JSON.stringify(Object.fromEntries(['href', 'origin', 'protocol', 'hostname', 'pathname', 'username', 'password', 'search', 'hash'].map(key => [key, u[key as keyof URL]]))); } catch { return 'null'; } },
    nativeLanguage: (value: string) => ({ Swedish: 'sv', svenska: 'sv', swe: 'sv', sv: 'sv', German: 'de', Deutsch: 'de', de: 'de' }[value] ?? 'en'),
    nativeTimer: () => {}, nativeCancelFetch: () => {}, nativeProgress: () => {},
    nativeFetch: (_id: string, url: string, raw: string, callback: (status: number, text: string, error: string) => void) => {
      const options = JSON.parse(raw); calls.push({ url, options });
      const res = response(url, options.body); queueMicrotask(() => callback(res.status, JSON.stringify(res.body), ''));
    },
    nativeComplete: (id: string, raw: string, error: string) => { const callback = completions.get(id)!; completions.delete(id); if (error) callback.reject(new Error(error)); else callback.resolve(JSON.parse(raw)); },
  });
  runInContext(runtime, context); runInContext(bundle, context);
  return {
    calls,
    restart: (first: unknown, retry: unknown) => new Promise<CheckResult>((resolve, reject) => {
      const id = crypto.randomUUID(); completions.set(id, { resolve, reject });
      runInContext(`VegsnapCore.check(${JSON.stringify(id)}, ${JSON.stringify(JSON.stringify(first))}); VegsnapCore.cancel(${JSON.stringify(id)}); VegsnapCore.check(${JSON.stringify(id)}, ${JSON.stringify(JSON.stringify(retry))});`, context);
    }),
    call: (operation: string, args: unknown) => JSON.parse(runInContext(`VegsnapCore.call(${JSON.stringify(operation)}, ${JSON.stringify(JSON.stringify(args))})`, context)),
    check: (args: unknown) => new Promise<CheckResult>((resolve, reject) => { const id = crypto.randomUUID(); completions.set(id, { resolve, reject }); runInContext(`VegsnapCore.check(${JSON.stringify(id)}, ${JSON.stringify(JSON.stringify(args))})`, context); }),
  };
}
describe('iOS JavaScriptCore host contract', () => {
  test('offline search ranks overlapping packs before filtering and pagination', () => {
    const app = harness();
    const products = bundled.products.filter(p => p.source === 'off').slice(0, 21).map(p => ({ ...p, name: 'old', brands: 'overlap-fixture', countries_tags: ['en:germany'], last_modified_t: p.last_modified_t + 1 }));
    const old = { ...bundled, generatedAt: '2026-01-01T00:00:00Z', products };
    const fresh = { ...old, generatedAt: '2026-02-01T00:00:00Z', products: products.map(p => ({ ...p, name: 'fresh', last_modified_t: p.last_modified_t + 1 })) };
    const latest = { ...fresh, generatedAt: '2026-03-01T00:00:00Z', products: fresh.products.map(p => ({ ...p, name: 'latest' })) };
    const otherMarket = { ...latest, products: [{ ...latest.products[0], name: 'wrong market', countries_tags: ['en:france'], last_modified_t: latest.products[0].last_modified_t + 999 }] };
    app.call('snapshots', [old, fresh, latest, otherMarket]);
    const first: { code: string; name: string }[] = app.call('offlineSearch', { source: 'off', query: 'overlap-fixture', offset: 0 });
    const second: { code: string; name: string }[] = app.call('offlineSearch', { source: 'off', query: 'overlap-fixture', offset: 20 });
    expect(first).toHaveLength(20); expect(second).toHaveLength(1);
    expect(new Set([...first, ...second].map(p => p.code)).size).toBe(21);
    expect([...first, ...second].every(p => p.name === 'latest')).toBe(true);
    expect(app.call('offlineSearch', { source: 'off', query: 'wrong market', offset: 0 })).toHaveLength(0);
  });

  test('offline search finds base and localized product names', () => {
    const app = harness();
    const product = { ...bundled.products.find(p => p.source === 'off')!, name: 'base-fixture', name_de: 'Beispiel-fixture', name_en: 'Example-fixture', countries_tags: ['en:germany'], last_modified_t: 2_000_000_000 };
    app.call('snapshots', [{ ...bundled, products: [product] }]);
    for (const query of ['base-fixture', 'BEISPIEL-fixture', 'example-fixture']) {
      const results: { code: string }[] = app.call('offlineSearch', { source: 'off', query, offset: 0 });
      expect(results.map(p => p.code)).toEqual([product.code]);
    }
  });

  test('an old cancelled operation cannot complete its same-ID retry', async () => {
    const app = harness();
    const args = { offline: true, aiEnabled: false };
    const result = await app.restart(
      { ...args, input: { text: 'Ingredients: honey', category: 'food', complete: true } },
      { ...args, input: { text: 'Ingredients: oats, water', category: 'food', complete: true } },
    );
    expect(result.outcome).toBe('vegan');
  });

  test('exports the engine and evaluates offline without network', async () => {
    const app = harness();
    const result = await app.check({ input: { text: 'Ingredients: oats, honey', category: 'food', locale: 'en' }, offline: true, aiEnabled: false });
    expect(result.outcome).toBe('not_vegan'); expect(app.calls).toHaveLength(0);
  });
  test('native URL adapter rejects insecure or credential-bearing providers', () => {
    const app = harness();
    expect(() => app.call('provider', { baseUrl: 'https://secret@example.org/v1', model: 'model' })).toThrow();
    expect(() => app.call('provider', { baseUrl: 'http://example.org/v1', model: 'model' })).toThrow();
    expect(app.call('provider', { baseUrl: 'http://127.0.0.1:11434/v1', model: 'model' })).toBe(true);
    expect(app.call('barcode', '4006381333932')).toBeNull();
  });
  test('database response passes through bounded native fetch and stays unverified', async () => {
    const app = harness(() => ({ status: 200, body: { product: { code: '4006381333931', product_name: 'Fixture', ingredients_text: 'oats, honey', countries_tags: ['en:germany'] } } }));
    const result = await app.check({ input: { barcode: '4006381333931', category: 'food', locale: 'en' }, aiEnabled: false });
    expect(result.outcome).toBe('not_vegan'); expect(result.identity.match).toBe('exact_barcode'); expect(app.calls).toHaveLength(1);
  });
  test('barcode-only checks can research database identity without promoting database text', async () => {
    const app = harness(url => url.includes('/product/')
      ? { status: 200, body: { product: { code: '4006381333931', product_name: 'Fixture', brands: 'Example', ingredients_text: 'water, mystery', countries_tags: ['en:germany'] } } }
      : { status: 200, body: { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ text: '', complete: false, category: 'food', name: 'Fixture', brand: 'Example' }) } }] } });
    const result = await app.check({ input: { barcode: '4006381333931', category: 'food', locale: 'en' }, aiEnabled: true, provider: { baseUrl: 'https://example.org/v1', model: 'test' } });
    expect(result.usedAI).toBe(true); expect(result.evidence.some(e => e.kind === 'database')).toBe(true);
    expect(result.evidence.filter(e => e.kind === 'user_text').every(e => !e.excerpt.includes('mystery'))).toBe(true);
    expect(app.calls).toHaveLength(2);
  });
  test('compatible API extraction cannot erase supplied animal ingredients', async () => {
    const app = harness(() => ({ status: 200, body: { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ text: 'water', complete: true, category: 'food' }) } }] } }));
    const result = await app.check({ input: { text: 'Ingredients: water, mystery', complete: true, category: 'food', locale: 'en' }, aiEnabled: true, provider: { baseUrl: 'https://example.org/v1', model: 'test' } });
    expect(result.outcome).toBe('uncertain'); expect(result.aiStatus).toBe('failed');
  });
  test('ChatGPT transport requests SSE and omits unsupported token limits', async () => {
    const app = harness(() => ({ status: 200, body: { status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify({ text: 'mystery', complete: false, category: 'food' }) }] }] } }));
    await app.check({ input: { text: 'mystery', complete: false, category: 'food', locale: 'en' }, aiEnabled: true, chatGPT: true, provider: { baseUrl: 'https://api.openai.com/v1', model: 'test' } });
    expect(app.calls[0]?.options.chatGPT).toBe(true);
    const body = JSON.parse(app.calls[0]!.options.body!);
    expect(body.stream).toBe(true); expect(body.store).toBe(false); expect(body.max_output_tokens).toBeUndefined(); expect(body.max_tool_calls).toBeUndefined();
  });
  test('offline import validates source attribution and never trusts claims', () => {
    const app = harness(); expect(() => app.call('snapshot', { schemaVersion: 1, region: 'DE', generatedAt: new Date().toISOString(), sources: [], products: [] })).toThrow();
    expect(app.call('packs', '').length).toBeGreaterThan(0);
  });
  test('OCR without a composition heading cannot become an ingredient list', () => {
    const app = harness(); const result = app.call('analyze', { text: '', category: 'food', complete: false });
    const after = app.call('mergeOCR', { result, input: { category: 'food' }, text: '100% VEGAN!\nBrand name\nwater' });
    expect(after.outcome).toBe('uncertain'); expect(after.findings).toHaveLength(0);
  });
});

test('iOS hosted checks use the shared validated service adapter', async () => {
  const app = harness(() => ({ status: 200, body: { text: 'Ingredients: water, mystery', complete: false, category: 'food' } }));
  const result = await app.check({ input: { text: 'Ingredients: water, mystery', category: 'food', locale: 'en' }, aiEnabled: true, hostedToken: 'a'.repeat(64) });
  expect(result.usedAI).toBe(true);
  expect(app.calls[0]?.url).toEndWith('/api/check');
  expect(JSON.parse(app.calls[0]!.options.body!).text).toBe('Ingredients: water, mystery');
});
test('offline hosted checks make no request', async () => {
  const app = harness();
  await app.check({ input: { text: 'mystery', category: 'food', locale: 'en' }, offline: true, aiEnabled: true, hostedToken: 'a'.repeat(64) });
  expect(app.calls).toHaveLength(0);
});

for (const chatGPT of [false, true]) test(`catalogue recovery uses public transport and retains UTF-8 composition (ChatGPT: ${chatGPT})`, async () => {
  const extraction = { text: '', complete: false, category: 'food', name: 'Hummus med chili', brand: 'Coop', packaging: { language: 'sv', country: 'Sverige', quantity: '200 g', variant: 'chili' } };
  const product = { name: 'Hummus chili', brand: 'Coop', weight_pretty: '200g', slug: 'produkt/hummus-chili-200g-coop', ingredients: 'Ingredienser: kikärtor, honey, salt' };
  let aiCalls = 0;
  const app = harness((url, body) => {
    if (url === 'https://api.matspar.se/slug') return { status: 200, body: JSON.parse(body!).slug === '/kategori'
      ? { type: 'category', payload: { products: [product] } } : { type: 'product', payload: product } };
    if (url.endsWith('/responses')) return ++aiCalls === 1
      ? { status: 200, body: { status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify(extraction) }] }] } }
      : { status: 503, body: {} };
    return { status: 404, body: {} };
  });
  const result = await app.check({ input: { images: ['data:image/jpeg;base64,AA=='], locale: 'en' }, provider: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o', supportsVision: true }, chatGPT, aiEnabled: true });
  expect(result.outcome).toBe('not_vegan');
  expect(result.evidence.some(e => e.url === 'https://www.matspar.se/produkt/hummus-chili-200g-coop' && e.excerpt === product.ingredients)).toBe(true);
  const requests = app.calls.filter(call => call.url === 'https://api.matspar.se/slug');
  expect(requests).toHaveLength(2);
  expect(requests.every(call => call.options.chatGPT === false && !JSON.parse(call.options.body!).stream)).toBe(true);
  expect(app.calls.filter(call => call.url.endsWith('/responses')).every(call => call.options.chatGPT === chatGPT)).toBe(true);
  expect(result.evidence.filter(e => e.id === 'ai-extraction').some(e => e.excerpt === product.ingredients)).toBe(false);
});

test('packaging matches preserve complete database composition, source and app language', async () => {
  const extraction = { text: '', complete: false, category: 'food', name: 'Coop Hummus med chili', brand: 'Coop', packaging: { language: 'Swedish', quantity: '200 g', country: 'Sweden', variant: 'med chili' }, ingredientAssessments: [{ term: 'kikärtor', status: 'plant', explanation: 'Chickpeas are plants.' }] };
  const product = { code: '4006381333931', product_name: 'Other base name', product_name_sv: 'Hummus chili', brands: 'Coop', quantity: '200g', countries_tags: ['en:sweden'], ingredients_text_sv: 'kikärtor, honey, salt' };
  const app = harness(url => url.includes('/cgi/search.pl') ? { status: 200, body: { count: 1, products: [product] } }
    : { status: 200, body: { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(extraction) } }] } });
  const result = await app.check({ input: { images: ['data:image/jpeg;base64,AA=='], locale: 'de' }, provider: { baseUrl: 'https://fixture.invalid/v1', model: 'vision', supportsVision: true }, aiEnabled: true });
  expect(result.outcome).toBe('not_vegan');
  expect(result.identity.match).toBe('unconfirmed');
  expect(result.identity.barcode).toBeUndefined();
  expect(result.evidence.some(e => e.kind === 'database' && e.excerpt === product.ingredients_text_sv && e.url?.endsWith('/product/4006381333931'))).toBe(true);
  expect(result.findings.some(f => f.term === 'honey' && f.status === 'animal')).toBe(true);
  expect(new URL(app.calls.find(call => call.url.includes('/cgi/search.pl'))!.url).searchParams.get('lc')).toBe('sv');
});

for (const mismatch of ['brand', 'quantity', 'variant', 'market', 'ambiguous', 'pagination', 'empty'] as const) test(`packaging recovery rejects ${mismatch}`, async () => {
  const extraction = { text: '', complete: false, category: 'food', name: 'Hummus chili', brand: 'Coop', packaging: { language: 'sv', quantity: '200 g', country: 'Sweden' } };
  const product = { code: '4006381333931', product_name_sv: mismatch === 'variant' ? 'Hummus ginger' : 'Hummus chili', brands: mismatch === 'brand' ? 'Other' : 'Coop', quantity: mismatch === 'quantity' ? '140g' : '200g', countries_tags: [mismatch === 'market' ? 'en:germany' : 'en:sweden'], ingredients_text_sv: mismatch === 'empty' ? '' : 'honey' };
  const app = harness(url => url.includes('/cgi/search.pl') ? { status: 200, body: { count: mismatch === 'pagination' ? 21 : 1, products: mismatch === 'ambiguous' ? [product, product] : [product] } }
    : { status: 200, body: { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(extraction) } }] } });
  const result = await app.check({ input: { images: ['data:image/jpeg;base64,AA=='] }, provider: { baseUrl: 'https://fixture.invalid/v1', model: 'vision', supportsVision: true }, aiEnabled: true });
  expect(result.outcome).toBe('uncertain');
  expect(result.evidence.some(e => e.kind === 'database')).toBe(false);
});
