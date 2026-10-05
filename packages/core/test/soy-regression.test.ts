import { describe, expect, test } from 'bun:test';
import { analyzeText, compositionTerms, needsProcessingEvidence } from '../src/analyze';

// Public manufacturer ingredient text also present in the user's failed saved result.
const oddlygood = 'vesi, kuorittu soijapapu* 13 %, sokeri, tärkkelys, kalsium, suola, vitamiinit (riboflaviini (B2), B12, D2), jodi, hapate.\n\n* Allergioita tai intoleransseja aiheuttavat aineet korostettu';
const garant = 'Vatten, SOJABÖNOR 8%, surhetsreglerande medel (E170), vitaminer (D, E, riboflavin, B12).';

describe('saved Nordic soy-product regressions', () => {
  test('Finnish ordinary ingredients are recognized without inventing culture origin', () => {
    const result = analyzeText({ text: oddlygood, category: 'food', complete: true });
    for (const term of ['vesi', 'kuorittu soijapapu', 'sokeri', 'tärkkelys', 'suola']) expect(result.findings.find(item => item.term === term)?.status).toBe('plant');
    expect(result.findings.some(item => item.term.includes('allergioita'))).toBe(false);
    expect(result.findings.find(item => item.term === 'hapate')?.status).toBe('ambiguous');
    expect(result.outcome).toBe('uncertain');
  });
  test('vitamin groups retain actual vitamin forms instead of group labels and bare letters', () => {
    const terms = compositionTerms(garant);
    expect(terms).toContain('vitamin d');
    expect(terms).toContain('vitamin e');
    expect(terms).not.toContain('vitaminer');
    expect(terms).not.toContain('surhetsreglerande medel');
    expect(compositionTerms(oddlygood)).toContain('vitamin d2');
    expect(compositionTerms('vitaminer (D, mjölk)')).toContain('mjölk');
    expect(compositionTerms('vitaminer, vatten')).toContain('vitaminer');
  });
  test('unspecified vitamin D remains genuinely ambiguous', () => {
    const result = analyzeText({ text: garant, category: 'drink', complete: true, name: 'Garant Soja Dryck' });
    expect(result.findings.find(item => item.term === 'vitamin d')?.status).toBe('ambiguous');
    expect(result.findings.find(item => item.term === 'vitamin e')?.status).toBe('plant');
    expect(result.outcome).toBe('uncertain');
  });
  test('vitamin E itself does not excuse an animal-derived carrier', () => {
    expect(analyzeText({ text: 'water, vitamin E (gelatin)', category: 'food', complete: true }).outcome).toBe('not_vegan');
    expect(analyzeText({ text: 'water, tocopherol', category: 'food', complete: true }).outcome).toBe('vegan');
  });
  test('complete nonalcoholic drinks can have composition status while named wines need fining evidence', () => {
    expect(analyzeText({ text: 'water, soybeans, salt', category: 'drink', complete: true, name: 'Soy drink' }).outcome).toBe('vegan');
    for (const name of ['White wine', 'Öl', 'Alkoholfri öl']) expect(analyzeText({ text: 'water, sugar', category: 'drink', complete: true, name }).outcome).toBe('uncertain');
    expect(analyzeText({ text: 'water, milk', category: 'drink', complete: true, name: 'Soy drink' }).outcome).toBe('not_vegan');
  });
  test('German oil ingredients do not trigger the Swedish beer fining rule', () => {
    expect(needsProcessingEvidence({ name: 'Pflanzliches Getränk', text: 'Wasser, pflanzliches Öl', category: 'drink', locale: 'de' })).toBe(false);
    expect(needsProcessingEvidence({ name: 'Alkoholfri öl', text: 'water, sugar', category: 'drink', locale: 'de' })).toBe(true);
  });
  test('only exact allergy typography footnotes are removed; allergenic ingredients remain', () => {
    expect(compositionTerms('water, milk\n* Ämnen som kan orsaka allergier eller intoleranser är markerade')).toEqual(['water', 'milk']);
    expect(compositionTerms('water\n* milk')).toContain('milk');
    expect(compositionTerms('water\n* Allergioita tai intoleransseja aiheuttavat aineet korostettu. milk')).toContain('allergioita tai intoleransseja aiheuttavat aineet korostettu. milk');
  });
});

describe('researching remaining ingredient questions', () => {
  test('searched composition with a culture ambiguity gets one declaration lookup, preserving both sources', async () => {
    const { createOpenAIProvider, checkProduct } = await import('../src');
    const name = 'Oddlygood Soygurt Natural';
    const brand = 'Oddlygood';
    const ingredientUrl = 'https://www.oddlygood.com/fi/tuotteet/oddlygood-soygurt-1-kg-maustamaton/';
    const declarationUrl = 'https://www.dabas.com/productsheet/06430081491338';
    const initial = { text: '', complete: false, category: 'food', name, brand,
      webCompositions: [{ url: ingredientUrl, text: oddlygood, complete: true, sourceType: 'manufacturer', productName: name, brand }],
      ingredientAssessments: [{ term: 'hapate', status: 'ambiguous', explanation: 'The culture medium is unspecified.' }] };
    const followup = { text: '', complete: false, category: 'food', name, brand,
      webClaims: [{ url: declarationUrl, quote: 'Diettyp: Vegan. Uppgiftslämnare: Oddlygood Sweden AB.', claim: 'vegan', sourceType: 'manufacturer', productName: name, brand }] };
    const requests: Record<string, unknown>[] = [];
    const fetcher = (async (_url: unknown, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)));
      const second = requests.length === 2;
      return new Response(JSON.stringify({ status: 'completed', output: [
        { type: 'web_search_call', status: 'completed', action: { sources: [{ url: second ? declarationUrl : ingredientUrl }] } },
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify(second ? followup : initial) }] },
      ] }));
    }) as typeof fetch;
    const result = await checkProduct({ images: ['data:image/jpeg;base64,AA=='], text: 'Private refrigerator note' }, { mode: 'explicit', provider: createOpenAIProvider({ baseUrl: 'https://api.openai.com/v1', model: 'test' }, fetcher) });
    expect(requests).toHaveLength(2);
    expect(requests[1]?.tool_choice).toBe('required');
    expect(JSON.stringify(requests[1]?.input)).toContain('hapate');
    expect(JSON.stringify(requests[1]?.input)).not.toContain('Private refrigerator note');
    expect(JSON.stringify(requests[1]?.input)).not.toContain('input_image');
    expect(result.outcome).toBe('vegan');
    expect(result.basis).toBe('manufacturer');
    expect(result.evidence.some(item => item.url === ingredientUrl)).toBe(true);
    expect(result.evidence.some(item => item.url === declarationUrl)).toBe(true);
    expect(result.findings.find(item => item.term === 'hapate')?.status).toBe('ambiguous');
  });
});
