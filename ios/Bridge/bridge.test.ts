import { describe, expect, test } from 'bun:test';
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
    call: (operation: string, args: unknown) => JSON.parse(runInContext(`VegsnapCore.call(${JSON.stringify(operation)}, ${JSON.stringify(JSON.stringify(args))})`, context)),
    check: (args: unknown) => new Promise<CheckResult>((resolve, reject) => { const id = crypto.randomUUID(); completions.set(id, { resolve, reject }); runInContext(`VegsnapCore.check(${JSON.stringify(id)}, ${JSON.stringify(JSON.stringify(args))})`, context); }),
  };
}
describe('iOS JavaScriptCore host contract', () => {
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
