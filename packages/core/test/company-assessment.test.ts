import { describe, expect, test } from 'bun:test';
import { analyzeText, applyCompanyAssessment, checkProduct, createOpenAIProvider, parseAIExtraction, parseCompanyAssessment, parseResultCompanyAssessment, type AICompanyAssessment, type AIExtraction } from '../src';

const url = 'https://maker.example/animal-testing';
const ownership = 'https://parent.example/brands';
const assessment: AICompanyAssessment = { brand: 'Maker', company: 'Maker Ltd', scope: 'direct', verdict: 'concerns_found', summary: 'The company describes animal testing required under specified regulations.', categories: ['animal_testing'], sources: [{ url, title: 'Maker policy', quote: 'Testing is conducted where required by law.' }] };
const extraction: AIExtraction = { text: 'vitamin D', complete: true, category: 'food', name: 'Drink', brand: 'Maker', companyAssessment: assessment, research: { searched: true, sources: [{ url, title: 'Maker policy' }] } };
const input = { images: ['data:image/jpeg;base64,AA=='], name: 'Drink', brand: 'Maker' };
const check = (extracted = extraction) => checkProduct(input, { mode: 'explicit', provider: { supportsWebSearch: true, extract: async () => extracted } });
const result = () => analyzeText({ text: 'vitamin D', name: 'Drink', brand: 'Maker' });

describe('sourced AI company assessments', () => {
  test('keeps product findings, verdict and reviewed records independent for every product outcome', () => {
    for (const outcome of ['vegan', 'not_vegan', 'uncertain', 'conflicting'] as const) {
      const original = { ...result(), outcome };
      const attached = applyCompanyAssessment(original, input, extraction);
      expect(attached.companyAssessment).toEqual({ ...assessment, assessedAt: original.checkedAt });
      const { companyAssessment: _assessment, ...product } = attached;
      expect(product).toEqual(original);
    }
  });
  test('requires exact brand identity, completed search, every source and final database identity', () => {
    for (const invalid of [
      { ...extraction, brand: undefined },
      { ...extraction, research: undefined },
      { ...extraction, research: { searched: false, sources: extraction.research!.sources } },
      { ...extraction, companyAssessment: { ...assessment, brand: 'Maker other' } },
      { ...extraction, companyAssessment: { ...assessment, sources: [...assessment.sources, { url: ownership, title: 'Unconsulted', quote: 'A claim.' }] } },
    ]) expect(applyCompanyAssessment(result(), input, invalid).companyAssessment).toBeUndefined();
    expect(applyCompanyAssessment({ ...result(), identity: { market: 'DE', match: 'unconfirmed' } }, input, extraction).companyAssessment).toBeUndefined();
    expect(applyCompanyAssessment(result(), { ...input, brand: 'Other brand' }, extraction).companyAssessment).toBeUndefined();
    expect(applyCompanyAssessment({ ...result(), identity: { ...result().identity, brand: 'Other brand' } }, input, extraction).companyAssessment).toBeUndefined();
  });
  test('requires a consulted ownership source for parent assessment', () => {
    const parent = { ...assessment, scope: 'parent' as const, company: 'Parent', ownershipSourceUrl: ownership };
    expect(applyCompanyAssessment(result(), input, { ...extraction, companyAssessment: parent }).companyAssessment).toBeUndefined();
    const sourced = { ...extraction, companyAssessment: parent, research: { searched: true, sources: [...extraction.research!.sources, { url: ownership, title: 'Ownership' }] } };
    expect(applyCompanyAssessment(result(), input, sourced).companyAssessment?.company).toBe('Parent');
    expect(parseCompanyAssessment({ ...parent, ownershipSourceUrl: undefined })).toBeUndefined();
  });
  test('drops malformed optional output without failing useful product evidence', async () => {
    const { research: _research, ...model } = extraction;
    const invalid = [null, {}, 'unsupported', { ...assessment, categories: [] }, { ...assessment, categories: ['animal_testing', 'animal_testing'] },
      { ...assessment, verdict: 'no_concerns_found' }, { ...assessment, sources: [] }, { ...assessment, sources: [{ url, title: 'Policy', quote: '' }] },
      { ...assessment, sources: [{ url: 'https://user:secret@maker.example', title: 'Policy', quote: 'Excerpt' }] },
      { ...assessment, sources: [{ url: 'https://localhost', title: 'Policy', quote: 'Excerpt' }] },
      { ...assessment, sources: [{ url, title: 'Policy', quote: 'Excerpt', invented: true }] },
      { ...assessment, summary: 'x'.repeat(1501) }, { ...assessment, brand: 'Maker\nOther' }, { ...assessment, summary: 'Hidden\u0000control' },
    ];
    for (const companyAssessment of invalid) {
      const parsed = parseAIExtraction(JSON.stringify({ ...model, companyAssessment }));
      expect(parsed.companyAssessment).toBeUndefined();
      expect(parsed.text).toBe('vitamin D');
    }
    const checked = await check({ ...extraction, companyAssessment: { ...assessment, sources: [] } });
    expect(checked.usedAI).toBe(true);
    expect(checked.outcome).toBe('uncertain');
    expect(checked.companyAssessment).toBeUndefined();
  });
  test('accepts qualified no-concern and inconclusive assessments only with cited sources', () => {
    for (const verdict of ['no_concerns_found', 'inconclusive'] as const) {
      expect(parseCompanyAssessment({ ...assessment, verdict, categories: [] })?.verdict).toBe(verdict);
      expect(parseCompanyAssessment({ ...assessment, verdict, categories: [], sources: [] })).toBeUndefined();
    }
    expect(parseCompanyAssessment({ ...assessment, summary: 'Two lines\nwith a\ttab.' })).toBeDefined();
  });
  test('rejects malformed saved dates and preserves a proper assessment date', () => {
    for (const assessedAt of ['2026', '2026-10-06', '2026-02-30T12:00:00Z', 'not a date']) expect(parseResultCompanyAssessment({ ...assessment, assessedAt })).toBeUndefined();
    expect(parseResultCompanyAssessment({ ...assessment, assessedAt: '2026-10-06T12:00:00.000Z' })?.verdict).toBe('concerns_found');
  });
  test('does not trigger company-only AI for decisive, offline or background checks', async () => {
    let calls = 0;
    const provider = { extract: async () => { calls++; return extraction; } };
    for (const options of [{ mode: 'background' as const }, { mode: 'explicit' as const, offline: true }]) {
      expect((await checkProduct(input, { ...options, provider })).companyAssessment).toBeUndefined();
    }
    expect((await checkProduct({ text: 'milk', brand: 'Maker' }, { mode: 'explicit', provider })).outcome).toBe('not_vegan');
    expect(calls).toBe(0);
  });
  test('returns company research even when the same AI extraction resolves the product', async () => {
    const checked = await check({ ...extraction, text: 'milk' });
    expect(checked.outcome).toBe('not_vegan');
    expect(checked.companyAssessment?.verdict).toBe('concerns_found');
  });
  test('keeps sourced company research separate from existing reviewed parent records', async () => {
    const checked = await checkProduct({ images: input.images }, { mode: 'explicit', provider: { extract: async () => ({ ...extraction, brand: 'Garden Gourmet', companyAssessment: { ...assessment, brand: 'Garden Gourmet', verdict: 'no_concerns_found', categories: [] } }) } });
    expect(checked.companyConcerns[0]?.scope).toBe('parent');
    expect(checked.companyAssessment?.verdict).toBe('no_concerns_found');
  });
  test('safe-shaped but unsourced follow-up cannot replace a valid first assessment', async () => {
    for (const sourced of [true, false]) {
      let calls = 0;
      const { research: _research, ...original } = extraction;
      const provider = createOpenAIProvider({ baseUrl: 'https://api.openai.com/v1', model: 'selected', supportsVision: true }, (async () => {
        calls++;
        const data = calls === 1 ? { ...original, text: '', complete: false } : { ...original, text: '', complete: false, companyAssessment: { ...assessment, summary: 'Follow-up assessment.', sources: [{ url: ownership, title: 'Follow-up source', quote: 'New supporting excerpt.' }] } };
        return new Response(JSON.stringify({ status: 'completed', output: [
          { type: 'web_search_call', status: 'completed', action: { type: 'open_page', url: calls === 2 && sourced ? ownership : url } },
          { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify(data), annotations: [] }] },
        ] }));
      }) as unknown as typeof fetch);
      const checked = await checkProduct(input, { mode: 'explicit', provider });
      expect(calls).toBe(2);
      expect(checked.companyAssessment?.summary).toBe(sourced ? 'Follow-up assessment.' : assessment.summary);
    }
  });
});
