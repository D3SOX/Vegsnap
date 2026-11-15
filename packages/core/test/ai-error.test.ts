import { expect, test } from 'bun:test';
import { checkProduct, createOpenAIProvider } from '../src';
import { createHostedAIProvider } from '../src/hosted-ai';

const failing = (response: Response) => Object.assign(async () => response.clone(), { preconnect: fetch.preconnect });
test('a failed AI check records fixed localized copy instead of the provider error', async () => {
  const provider = createOpenAIProvider({ baseUrl: 'https://api.openai.com/v1', model: 'fixture' },
    failing(Response.json({ error: { code: 'insufficient_quota', message: 'PRIVATE provider text' } }, { status: 429 })));
  const result = await checkProduct({ text: 'Zutaten: Wasser, Aroma', locale: 'de' }, { mode: 'explicit', provider });
  expect(result.aiStatus).toBe('failed');
  expect(result.aiError?.code).toBe('quota');
  expect(result.warnings).toContain(result.aiError!.message);
  expect(result.warnings.join(' ')).not.toMatch(/PRIVATE|HTTP 429/);
  expect(result.aiError!.message).toBe('Ein KI-Nutzungslimit wurde erreicht. Prüfe die Nutzungseinstellungen deines Anbieters. Öffne bei ChatGPT Einstellungen → Nutzung.');
});
test('hosted quota and rate limits use the Vegsnap AI copy', async () => {
  const provider = createHostedAIProvider('a'.repeat(64), failing(Response.json({ error: { message: 'Slow down.', code: 'usage_limit_reached' } }, { status: 429 })));
  const result = await checkProduct({ text: 'Ingredients: water, flavouring' }, { mode: 'explicit', provider });
  expect(result.aiError).toEqual({ code: 'quota', message: 'The free Vegsnap AI allowance is used up. It resets at midnight UTC.' });
});
test('a changed transcription is reported in the user language', async () => {
  const result = await checkProduct({ text: 'Ingredienser: vatten, arom', locale: 'sv' }, { mode: 'explicit',
    provider: { extract: async () => ({ text: 'vatten', complete: true, category: 'food' }) } });
  expect(result.aiError?.code).toBe('invalid_response');
  expect(result.warnings).toContain('AI-tolkningen ändrade den angivna texten; de ursprungliga beläggen behölls.');
});
test('classification works without DOMException, as in JavaScriptCore', async () => {
  const { aiErrorCode } = await import('../src/ai-error');
  const original = globalThis.DOMException;
  try {
    // @ts-expect-error simulate a runtime without the constructor
    delete globalThis.DOMException;
    expect(aiErrorCode(Object.assign(new Error('timed out'), { name: 'TimeoutError' }))).toBe('timeout');
  } finally { globalThis.DOMException = original; }
});
