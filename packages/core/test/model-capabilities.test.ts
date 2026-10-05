import { describe, expect, test } from 'bun:test';
import { acceptsImages, createOpenAIProvider, imageSupport } from '../src';

describe('automatic model image capabilities', () => {
  test('recognizes current image-capable and known text-only models', () => {
    for (const model of ['gpt-6-astra', 'gpt-6.1-sol', 'gpt-5.6-sol', 'gpt-4o-mini', 'gpt-4.1', 'openai/gpt-4o', 'o3', 'o4-mini']) expect(imageSupport(model)).toBe('supported');
    for (const model of ['gpt-3.5-turbo', 'gpt-4', 'gpt-4-0613', 'o1-mini', 'o1-preview', 'o3-mini']) expect(imageSupport(model)).toBe('unsupported');
  });
  test('explicit catalog metadata overrides model family guesses', () => {
    expect(imageSupport('gpt-6-astra', { supportsImages: false })).toBe('unsupported');
    expect(imageSupport('gpt-4', { input_modalities: ['text', 'image'] })).toBe('supported');
    expect(imageSupport('custom', { architecture: { input_modalities: ['text'] } })).toBe('unsupported');
    expect(imageSupport('custom', { supports_image_input: true })).toBe('supported');
    expect(imageSupport('custom', { capabilities: { vision: false } })).toBe('unsupported');
  });
  test('absent, empty or invalid metadata does not silently disable unfamiliar models', () => {
    for (const metadata of [undefined, {}, { input_modalities: [] }, { supportsImages: 'false' }, { output_modalities: ['text'] }]) {
      expect(imageSupport('local-custom', metadata)).toBe('unknown');
      expect(acceptsImages('local-custom', metadata)).toBe(true);
    }
  });
  test('an unfamiliar compatible model receives the photo without manual opt-in', async () => {
    let body: Record<string, unknown> | undefined;
    const provider = createOpenAIProvider({ baseUrl: 'http://localhost:11434/v1', model: 'local-custom' }, (async (_url: string | URL | Request, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ text: '', complete: false, category: 'other' }) } }] }));
    }) as unknown as typeof fetch);
    await provider.extract({ images: ['data:image/jpeg;base64,YQ=='] });
    expect(body).toMatchObject({ messages: [{ role: 'system' }, { role: 'user', content: [{ type: 'text' }, { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,YQ==' } }] }] });
  });
});
