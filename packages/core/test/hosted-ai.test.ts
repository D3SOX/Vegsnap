import { expect, test } from 'bun:test';
import { createHostedAIProvider, HOSTED_AI } from '../src/hosted-ai';

test('hosted adapter sends product data to its fixed origin and preserves validated research metadata', async () => {
  let received: Request | undefined;
  const fetcher = Object.assign(async (url: string | URL | Request, init?: RequestInit) => {
    received = new Request(url, init);
    return Response.json({ text: '', category: 'other', complete: false, research: { searched: true, sources: [{ url: 'https://maker.example/product', title: 'Product' }] } });
  }, { preconnect: globalThis.fetch.preconnect });
  const result = await createHostedAIProvider('a'.repeat(64), fetcher).extract({ name: 'Product', images: ['data:image/jpeg;base64,AA=='] });
  expect(received?.url).toBe(`${HOSTED_AI.baseUrl}/api/check`);
  expect(received?.headers.get('Authorization')).toBe(`Bearer ${'a'.repeat(64)}`);
  expect(await received?.json()).toEqual({ name: 'Product', images: ['data:image/jpeg;base64,AA=='] });
  expect(result.research?.searched).toBe(true);
});
test('missing hosted session prevents network access', async () => {
  let calls = 0;
  const fetcher = Object.assign(async () => { calls++; return Response.json({}); }, { preconnect: globalThis.fetch.preconnect });
  await expect(createHostedAIProvider('', fetcher).extract({ name: 'Product' })).rejects.toThrow('Connect');
  expect(calls).toBe(0);
});
test('invalid hosted responses and exhausted allowances cannot become extraction results', async () => {
  for (const response of [Response.json({ text: '', complete: true, category: 'other' }), Response.json({ error: 'private details' }, { status: 429 })]) {
    const fetcher = Object.assign(async () => response, { preconnect: globalThis.fetch.preconnect });
    await expect(createHostedAIProvider('a'.repeat(64), fetcher).extract({ name: 'Product' })).rejects.toThrow();
  }
});
