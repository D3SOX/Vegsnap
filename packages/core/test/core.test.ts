import { describe, expect, test, mock } from 'bun:test';
import fixtures from '../../../fixtures/composition.json';
import { analyzeText, applyVerifiedEvidence, checkProduct, createOpenAIProvider, lookupProduct, normalizeBarcode, parseAIExtraction } from '../src';
import type { Basis, CheckInput, Evidence, Outcome, ProviderAdapter } from '../src';
import { readBoundedText } from '../src/http';

const now = () => new Date('2026-10-05T10:00:00Z');
const code = '4006381333931';
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const product = (text = 'water, salt', extra: Record<string, unknown> = {}) => ({ status: 'success', product: {
  code, product_name: 'Example', ingredients_text: text, countries_tags: ['en:germany'], labels_tags: ['en:vegan'], ...extra,
} });

describe('shared composition fixtures', () => {
  test('a barcode is identity, not an unknown ingredient or a complete vegan list', () => {
    const result = analyzeText({ text: code, barcode: code, category: 'food', complete: true });
    expect(result.findings).toEqual([]);
    expect(result.outcome).toBe('uncertain');
    expect(result.identity.barcode).toBe(code);
    expect(analyzeText({ text: `${code}, milk`, category: 'food', complete: true }).outcome).toBe('not_vegan');
  });
  for (const fixture of fixtures) test(fixture.id, () => {
    const result = analyzeText(fixture.input as CheckInput, now);
    expect(result.outcome).toBe(fixture.expected.outcome as Outcome);
    expect(result.basis).toBe(fixture.expected.basis as Basis);
    expect(result.companyConcerns).toEqual([]);
  });
  test('cross-contact warning is separate from ingredients', () => {
    const result = analyzeText({ text: 'Ingredients: water, salt. May contain milk.', category: 'food' }, now);
    expect(result.outcome).toBe('vegan');
    expect(result.crossContact).toEqual(['May contain milk.']);
    expect(result.findings.some(item => item.ruleId === 'milk')).toBe(false);
  });
  test('Swedish cross-contact stays separate and plant compounds use whole-term matches', () => {
    const result = analyzeText({ text: 'Ingredienser: havremjölk, kakaosmör, salt. Kan innehålla spår av mjölk och ägg.', category: 'food' }, now);
    expect(result.outcome).toBe('vegan');
    expect(result.crossContact).toEqual(['Kan innehålla spår av mjölk och ägg.']);
    expect(result.findings.map(item => item.ruleId)).toEqual(['oat', 'cocoa-butter', 'salt']);
    const unknown = analyzeText({ text: 'Ingredienser: vatten, okänd tillsats', category: 'food' }, now);
    expect(unknown.findings.map(item => item.status)).toEqual(['plant', 'unknown']);
    expect(unknown.outcome).toBe('uncertain');
  });
  test('unsafe source links are not rendered as evidence URLs', () => {
    expect(analyzeText({ text: 'milk', sourceUrl: 'javascript:alert(1)' }).evidence[0]?.url).toBeUndefined();
  });
  test('truncating an oversized composition never creates a complete vegan list', () => {
    const result = analyzeText({ text: `Ingredients: ${'water, '.repeat(4000)}milk`, category: 'food', complete: true });
    expect(result.outcome).toBe('uncertain');
    expect(result.questions).toContain('Provide the complete ingredients or materials list.');
  });
  test('verified manufacturer claim conflicting with composition stays conflicting', () => {
    const original = analyzeText({ text: 'Ingredients: milk', category: 'food' });
    const evidence: Evidence = { id: 'manufacturer', kind: 'manufacturer', title: 'Product declaration', excerpt: 'Vegan',
      url: 'https://maker.example/product', retrievedAt: now().toISOString(), claim: 'vegan', verification: 'source' };
    expect(applyVerifiedEvidence(original, [evidence]).outcome).toBe('conflicting');
    expect(applyVerifiedEvidence(applyVerifiedEvidence(original, [evidence]), [{ ...evidence, id: 'second' }]).outcome).toBe('conflicting');
    expect(applyVerifiedEvidence(original, [{ ...evidence, verification: 'unverified' }]).outcome).toBe('not_vegan');
  });
});

describe('public database boundaries', () => {
  test('validates GTIN before any request', async () => {
    const fetcher = mock(async () => response(product())) as unknown as typeof fetch;
    expect(normalizeBarcode('4006381333932')).toBeUndefined();
    await expect(lookupProduct('4006381333932', { fetch: fetcher })).rejects.toThrow('checksum');
    expect(fetcher).not.toHaveBeenCalled();
  });
  test('preserves exact identity and source licensing without promoting tags to certification', async () => {
    const fetcher = mock(async () => response(product())) as unknown as typeof fetch;
    const result = await checkProduct({ barcode: code, category: 'food' }, { mode: 'background', fetch: fetcher, now });
    expect(result.outcome).toBe('uncertain');
    expect(result.basis).toBe('insufficient');
    expect(result.identity.match).toBe('exact_barcode');
    expect(result.evidence.at(-1)?.license).toContain('ODbL');
    await checkProduct({ barcode: code, category: 'food' }, { mode: 'background', fetch: fetcher, now });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  test('tries beauty and general products when food has no record', async () => {
    const urls: string[] = [];
    const fetcher = mock(async (url: string | URL | Request) => {
      urls.push(String(url));
      return String(url).includes('openproductsfacts') ? response(product('leather')) : response({ status: 'failure' });
    }) as unknown as typeof fetch;
    const result = await lookupProduct(code, { fetch: fetcher, now });
    expect(urls).toHaveLength(3);
    expect(result?.evidence.title).toBe('Open Products Facts');
  });
  test('rejects wrong variants and known market mismatch', async () => {
    for (const extra of [{ code: '9780201379624' }, { countries_tags: ['en:united-states'] }]) {
      const fetcher = mock(async () => response(product('milk', extra))) as unknown as typeof fetch;
      await expect(lookupProduct(code, { fetch: fetcher, now })).rejects.toThrow();
    }
  });
  test('explicit composition conflict is never hidden by a reassuring database', async () => {
    const fetcher = mock(async () => response(product('milk'))) as unknown as typeof fetch;
    const result = await checkProduct({ barcode: code, text: 'Ingredients: water, salt', complete: true, category: 'food' }, { mode: 'explicit', fetch: fetcher });
    expect(result.outcome).toBe('conflicting');
    expect(result.evidence).toHaveLength(2);
  });
});

describe('AI privacy and validation', () => {
  const extraction = { text: 'water, salt', complete: true, category: 'food' as const };
  for (const category of ['shoes', 'clothing', 'drink'] as const) {
    test(`Auto lets AI identify ${category} without treating plant composition as sufficient proof`, async () => {
      const text = category === 'drink' ? 'water, salt' : 'cotton';
      const extract = mock(async () => ({ text, complete: true, category, name: category === 'drink' ? 'White wine' : undefined }));
      const result = await checkProduct({ text, category: 'other', complete: true }, {
        mode: 'explicit', provider: { extract },
      });
      expect(extract).toHaveBeenCalledTimes(1);
      expect(result.category).toBe(category);
      expect(result.outcome).toBe('uncertain');
      expect(result.basis).toBe('insufficient');
      expect(result.usedAI).toBe(true);
      expect(result.questions.length).toBeGreaterThan(0);
    });
  }
  test('Auto allows a complete known plant list once AI identifies food', async () => {
    const result = await checkProduct({ text: 'Ingredients: water, salt', category: 'other' }, {
      mode: 'explicit', provider: { extract: async () => extraction },
    });
    expect(result.category).toBe('food');
    expect(result.outcome).toBe('vegan');
    expect(result.basis).toBe('composition');
    expect(result.usedAI).toBe(true);
  });
  test('Auto remains unknown without AI and offline mode cannot infer from a connected provider', async () => {
    const extract = mock(async () => extraction);
    const input = { text: 'water, salt', category: 'other' as const, complete: true };
    const withoutAI = await checkProduct(input, { mode: 'explicit' });
    const offline = await checkProduct(input, { mode: 'explicit', offline: true, provider: { extract } });
    for (const result of [withoutAI, offline]) {
      expect(result.category).toBe('other');
      expect(result.outcome).toBe('uncertain');
      expect(result.usedAI).toBe(false);
    }
    expect(extract).not.toHaveBeenCalled();
  });
  test('Auto accepts the database category without promoting an incomplete record to vegan', async () => {
    const fetcher = mock(async (url: string | URL | Request) => String(url).includes('world.openfoodfacts.org')
      ? response(product()) : response({ status: 'not_found' }, 404)) as unknown as typeof fetch;
    const result = await checkProduct({ barcode: code, category: 'other' }, { mode: 'explicit', fetch: fetcher });
    expect(result.category).toBe('food');
    expect(result.identity.match).toBe('exact_barcode');
    expect(result.outcome).toBe('uncertain');
    expect(result.usedAI).toBe(false);
  });
  test('AI cannot change a known shoe category to bypass missing production evidence', async () => {
    const result = await checkProduct({ text: 'Materials: cotton', category: 'shoes', complete: true }, {
      mode: 'explicit', provider: { extract: async () => ({ ...extraction, text: 'cotton' }) },
    });
    expect(result.category).toBe('shoes');
    expect(result.outcome).toBe('uncertain');
  });
  test('AI preserves exact database identity and equivalent barcodes do not duplicate sources', async () => {
    const fetcher = mock(async () => response(product())) as unknown as typeof fetch;
    const result = await checkProduct({ barcode: '4006 3813 3393 1', text: 'water, salt', category: 'food' }, {
      mode: 'explicit', fetch: fetcher, provider: { extract: async () => ({ ...extraction, barcode: `0${code}`, name: 'Guessed name' }) },
    });
    expect(result.identity).toMatchObject({ barcode: code, name: 'Example', match: 'exact_barcode' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(new Set(result.evidence.map(item => item.id)).size).toBe(result.evidence.length);
  });
  test('AI cannot substitute another valid product identifier', async () => {
    const fetcher = mock(async () => response(product())) as unknown as typeof fetch;
    const result = await checkProduct({ barcode: code, text: 'water, salt' }, {
      mode: 'explicit', fetch: fetcher, provider: { extract: async () => ({ ...extraction, barcode: '9780201379624' }) },
    });
    expect(result.identity.barcode).toBe(code);
    expect(result.warnings.join(' ')).toContain('different product barcode');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  test('background never invokes AI, including an unresolved image', async () => {
    const extract = mock(async () => extraction);
    await checkProduct({ images: ['data:image/png;base64,AAAA'] }, { mode: 'background', provider: { extract } });
    expect(extract).not.toHaveBeenCalled();
  });
  test('offline never contacts a database or provider', async () => {
    const extract = mock(async () => extraction);
    const fetcher = mock(async () => response(product())) as unknown as typeof fetch;
    await checkProduct({ barcode: code, text: 'unknown' }, { mode: 'explicit', offline: true, provider: { extract }, fetch: fetcher });
    expect(extract).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled();
  });
  test('database certainty avoids AI and no retry loop is used for unresolved checks', async () => {
    const extract = mock(async () => ({ ...extraction, text: '' , complete: false }));
    const provider: ProviderAdapter = { extract };
    const fetcher = mock(async () => response(product())) as unknown as typeof fetch;
    await checkProduct({ barcode: code, text: 'Ingredients: milk', category: 'food' }, { mode: 'explicit', provider, fetch: fetcher });
    expect(extract).not.toHaveBeenCalled();
    await checkProduct({ text: 'unclear label' }, { mode: 'explicit', provider });
    expect(extract).toHaveBeenCalledTimes(1);
  });
  test('AI cannot remove an unknown text ingredient or invent certification', async () => {
    const result = await checkProduct({ text: 'Ingredients: water, salt, mystery', category: 'food' }, {
      mode: 'explicit', provider: { extract: async () => ({ ...extraction, text: 'Ingredients: water, salt, cocoa' }) },
    });
    expect(result.outcome).toBe('uncertain');
    expect(result.warnings.join(' ')).toContain('changed');
    expect(() => parseAIExtraction(JSON.stringify({ ...extraction, certified: true }))).toThrow();
    expect(() => parseAIExtraction(JSON.stringify({ ...extraction, category: 'weapons' }))).toThrow();
  });
  test('a valid substring cannot truncate unknown ingredients and an AI cannot assert text completeness', async () => {
    const provider = { extract: async () => extraction };
    const cropped = await checkProduct({ text: 'Ingredients: water, salt, mystery', category: 'food' }, { mode: 'explicit', provider });
    expect(cropped.outcome).toBe('uncertain');
    const partial = await checkProduct({ text: 'water, salt', category: 'food' }, { mode: 'explicit', provider });
    expect(partial.outcome).toBe('uncertain');
  });
  test('Swedish heading is retained by the AI completeness and full-text guards', async () => {
    const provider = { extract: async () => ({ ...extraction, text: 'vatten, havre' }) };
    const full = await checkProduct({ text: 'Ingredienser: vatten, havre' }, { mode: 'explicit', provider });
    expect(full.outcome).toBe('vegan');
    const partial = await checkProduct({ text: 'vatten, havre', category: 'food' }, { mode: 'explicit', provider });
    expect(partial.outcome).toBe('uncertain');
    const changed = await checkProduct({ text: 'Ingredienser: vatten, havre, okänd tillsats', category: 'food' }, { mode: 'explicit', provider });
    expect(changed.outcome).toBe('uncertain');
    expect(changed.warnings.join(' ')).toContain('changed');
  });
  test('provider rejects unsafe endpoints and does not forward credentials on redirects', async () => {
    expect(() => createOpenAIProvider({ baseUrl: 'http://example.com/v1', token: 'secret', model: 'test' })).toThrow('HTTPS');
    expect(() => createOpenAIProvider({ baseUrl: 'https://user:pass@example.com/v1', model: 'test' })).toThrow();
    const fetcher = mock(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.redirect).toBe('error'); expect(init?.credentials).toBe('omit');
      expect(init?.headers).toMatchObject({ Authorization: 'Bearer test-secret' });
      expect(JSON.parse(String(init?.body)).messages[1].content[0].text).not.toContain('test-secret');
      return response({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(extraction) } }] });
    }) as unknown as typeof fetch;
    const provider = createOpenAIProvider({ baseUrl: 'https://example.com/v1/', token: 'test-secret', model: 'test' }, fetcher);
    expect(await provider.extract({ text: 'water, salt' })).toEqual(extraction);
  });
  test('truncated completion, unsupported images, remote images, and invented keys fail closed', async () => {
    const fetcher = mock(async () => response({ choices: [{ finish_reason: 'length', message: { content: JSON.stringify(extraction) } }] })) as unknown as typeof fetch;
    const provider = createOpenAIProvider({ baseUrl: 'http://localhost:11434/v1', model: 'local', supportsVision: false }, fetcher);
    await expect(provider.extract({ text: 'water' })).rejects.toThrow('incomplete');
    await expect(provider.extract({ images: ['data:image/png;base64,AAAA'] })).rejects.toThrow('vision');
    const vision = createOpenAIProvider({ baseUrl: 'https://example.com/v1', model: 'vision', supportsVision: true }, fetcher);
    await expect(vision.extract({ images: ['https://example.com/private-photo.jpg'] })).rejects.toThrow('locally sanitized');
  });
  test('caller cancellation is propagated', async () => {
    const controller = new AbortController(); controller.abort();
    await expect(checkProduct({ text: 'water' }, { mode: 'explicit', signal: controller.signal })).rejects.toThrow();
  });
  test('streaming size limits cancel an oversized response during reading', async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(500)); },
      cancel() { cancelled = true; },
    });
    await expect(readBoundedText(new Response(stream), 100)).rejects.toThrow('size limit');
    expect(cancelled).toBe(true);
  });
});
