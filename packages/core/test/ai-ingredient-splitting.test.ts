import { describe, expect, test } from 'bun:test';
import { analyzeText, checkProduct, createOpenAIProvider, parseSourceIngredients, validateAIExtraction, type AIExtraction } from '../src';
import { applyAIEvidence } from '../src/ai-evidence';
import { applyWebEvidence } from '../src/web-evidence';
import { mergeResults } from '../src/merge-results';

const source = 'https://example.org/product';
const medicine = 'Der Wirkstoff ist: Venlafaxin.\nDie sonstigen Bestandteile sind:\nKapselhülle: Gelatine, Eisen(III)-oxid (E172)\nDrucktinte: Schellack';
const terms = ['Venlafaxin', 'Gelatine', 'Eisen(III)-oxid (E172)', 'Schellack'];
const extraction = (locale: 'en' | 'de' = 'en'): AIExtraction => ({
  text: '', complete: false, category: 'other', name: 'Venlafaxin Aurobindo 75 mg', brand: 'Aurobindo',
  research: { searched: true, sources: [{ url: source, title: 'Product composition' }] },
  webCompositions: [{ url: source, text: medicine, complete: true, sourceType: 'retailer', productName: 'Venlafaxin Aurobindo 75 mg', brand: 'Aurobindo', ingredients: terms }],
  ingredientAssessments: terms.map((term, index) => ({ term,
    translatedTerm: (locale === 'de' ? ['Venlafaxin', 'Gelatine', 'Eisen(III)-oxid (E172)', 'Schellack'] : ['Venlafaxine', 'Gelatin', 'Iron(III) oxide (E172)', 'Shellac'])[index],
    status: index === 1 || index === 3 ? 'animal' : 'plant',
    explanation: locale === 'de' ? 'Herkunft anhand der chemischen Identität bewertet.' : 'Origin assessed from the chemical identity.' })),
});
const webCheck = (value: AIExtraction, locale: 'en' | 'de' = 'en') => {
  const input = { category: 'other' as const, locale };
  return applyWebEvidence(analyzeText(input), input, value);
};

describe('AI parses source-grounded ingredient names', () => {
  for (const locale of ['en', 'de'] as const) test(`medicine excludes role prose, preserves chemicals and translates names into ${locale}`, () => {
    const value = extraction(locale);
    const result = webCheck(value, locale);
    expect(result.outcome).toBe('not_vegan');
    expect(result.findings.map(finding => finding.term)).toEqual(['venlafaxin', 'gelatine', 'eisen(iii)-oxid (e172)', 'schellack']);
    expect(result.findings.map(finding => finding.displayTerm)).toEqual(value.ingredientAssessments!.map(item => item.translatedTerm));
    expect(result.findings.every(finding => finding.displayLocale === locale)).toBe(true);
    expect(result.findings.filter(finding => finding.status === 'animal').map(item => item.ruleId)).toEqual(['gelatin', 'shellac']);
    expect(result.findings[0]?.explanation).toStartWith(locale === 'de' ? 'KI-Einschätzung: Herkunft' : 'AI assessment: Origin');
    expect(result.evidence[0]?.excerpt).toBe(medicine);
    expect(result.evidence.filter(item => item.excerpt === medicine)).toHaveLength(1);
    expect(result.findings.every(finding => result.evidence.some(item => item.id === finding.evidenceId))).toBe(true);
    expect(result.evidence.some(item => item.id === 'composition')).toBe(false);
  });

  test('supplied composition is re-parsed without retaining punctuation fragments in a check', async () => {
    const text = 'Acidity regulator: mystery salt (X123)\nFlavour: novel seed';
    const result = await checkProduct({ text, complete: true, category: 'food' }, { mode: 'explicit', provider: { extract: async () => ({ text, complete: true, category: 'food', ingredients: ['mystery salt (X123)', 'novel seed'], ingredientAssessments: [
      { term: 'mystery salt (X123)', translatedTerm: 'mystery salt (X123)', status: 'plant', explanation: 'Mineral ingredient.' },
      { term: 'novel seed', translatedTerm: 'novel seed', status: 'plant', explanation: 'Botanical seed.' },
    ] }) } });
    expect(result.outcome).toBe('vegan');
    expect(result.findings.map(item => item.term)).toEqual(['mystery salt (x123)', 'novel seed']);
    expect(result.findings.every(item => item.evidenceId === 'ai-assessment')).toBe(true);
  });

  test('missing assessments leave unfamiliar parsed ingredients unresolved', () => {
    const input = { text: 'Ingredients: obscure grain, water', category: 'food' as const, complete: true };
    const result = applyAIEvidence(analyzeText(input), input, { ...input, ingredients: ['obscure grain', 'water'] }, true);
    expect(result.findings.map(item => [item.term, item.status])).toEqual([['obscure grain', 'unknown'], ['water', 'plant']]);
    expect(result.outcome).toBe('uncertain');
    expect(result.findings[0]?.explanation).toBe('The AI did not establish the origin of this ingredient.');
    const german = applyAIEvidence(analyzeText({ ...input, locale: 'de' }), { ...input, locale: 'de' }, { ...input, ingredients: ['obscure grain', 'water'] }, true);
    expect(german.findings[0]?.explanation).toBe('Die KI konnte die Herkunft dieser Zutat nicht feststellen.');
  });

  test('omitted animal and ambiguous ingredients survive the AI list and misleading whole-blend assessment', () => {
    const input = { text: 'Ingredients: blend (water, milk, E471)', category: 'food' as const, complete: true };
    const extracted: AIExtraction = { ...input, ingredients: ['blend (water, milk, E471)'], ingredientAssessments: [
      { term: 'blend (water, milk, E471)', status: 'plant', explanation: 'Incorrect whole-blend claim.' },
    ] };
    const result = applyAIEvidence(analyzeText(input), input, extracted, true);
    expect(result.outcome).toBe('not_vegan');
    expect(result.findings.find(item => item.term === 'milk')?.status).toBe('animal');
    expect(result.findings.find(item => item.term === 'e471')?.status).toBe('ambiguous');
    const omitted = applyAIEvidence(analyzeText(input), input, { ...extracted, ingredients: ['water'] }, true);
    expect(omitted.findings.map(item => item.status)).toEqual(['plant', 'animal', 'ambiguous']);
    expect(omitted.outcome).toBe('not_vegan');
  });

  test('omitting capsule and printing ingredients cannot hide bundled animal rules behind role headings', () => {
    const value = extraction();
    value.webCompositions![0]!.ingredients = ['Venlafaxin'];
    const result = webCheck(value);
    expect(result.outcome).toBe('not_vegan');
    expect(result.findings.filter(item => item.status === 'animal').map(item => item.term)).toEqual(['gelatine', 'schellack']);
  });

  test('hallucinated list is ignored with a warning while source evidence remains', () => {
    const input = { text: 'obscure seed, water', category: 'food' as const, complete: true };
    const result = applyAIEvidence(analyzeText(input), input, { ...input, ingredients: ['water', 'invented flour'] }, true);
    expect(result.findings.map(item => item.term)).toEqual(['obscure seed', 'water']);
    expect(result.warnings.join(' ')).toContain('could not be matched');
    expect(result.outcome).toBe('uncertain');
    expect(result.evidence[0]?.excerpt).toBe(input.text);
  });

  test('source grounding allows normalization but rejects substrings and precautionary allergens', () => {
    expect(parseSourceIngredients('ＭＩＬＫ, Novel\n SEED', ['milk', 'Novel seed'])).toEqual(['milk', 'novel seed']);
    expect(parseSourceIngredients('soy milk', ['soy'])).toEqual(['soy']);
    expect(parseSourceIngredients('buttermilk', ['milk'])).toBeUndefined();
    for (const precaution of ['May contain milk.', 'Kann Spuren von Milch enthalten.', 'Kan innehålla spår av mjölk.']) {
      const allergen = precaution.includes('Milch') ? 'Milch' : precaution.includes('mjölk') ? 'mjölk' : 'milk';
      expect(parseSourceIngredients(`water. ${precaution}`, ['water', allergen])).toBeUndefined();
      expect(parseSourceIngredients(`water. ${precaution}`, ['water'])).toEqual(['water']);
    }
  });

  test('invalid parsed-list shape cannot be accepted by the provider contract', () => {
    const base = { text: 'water', complete: true, category: 'food' };
    for (const ingredients of ['water', [1], [''], [' '], ['x'.repeat(301)], Array(101).fill('water')]) {
      expect(() => validateAIExtraction({ ...base, ingredients })).toThrow('parsed ingredients');
      const value = extraction();
      value.webCompositions![0]!.ingredients = ingredients as string[];
      expect(() => validateAIExtraction(value, { allowResearch: true })).toThrow('researched composition');
    }
    expect(parseSourceIngredients('water', [])).toBeUndefined();
    expect(validateAIExtraction({ ...base, ingredients: ['water'] }).ingredients).toEqual(['water']);
  });

  test('legacy output still uses local splitting', () => {
    const input = { text: 'mystery blend (rare seed)', category: 'food' as const, complete: true };
    const result = applyAIEvidence(analyzeText(input), input, input, true);
    expect(result.findings.map(item => item.term)).toEqual(['mystery blend', 'rare seed']);
    expect(result.warnings.some(item => item.includes('local splitting'))).toBe(false);
  });

  test('re-parsing supplied evidence preserves findings from a separate database source', () => {
    const input = { text: 'Composition: novel grain', category: 'food' as const, complete: true };
    const database = analyzeText({ text: 'milk', category: 'food', complete: true });
    database.evidence = [{ ...database.evidence[0]!, id: 'database-record', kind: 'database' }];
    database.findings = database.findings.map(item => ({ ...item, evidenceId: 'database-record' }));
    const initial = mergeResults(analyzeText(input), database);
    const result = applyAIEvidence(initial, input, { ...input, ingredients: ['novel grain'], ingredientAssessments: [
      { term: 'novel grain', status: 'plant', explanation: 'A cereal grain.' },
    ] }, true);
    expect(result.findings.some(item => item.term === 'milk' && item.evidenceId === 'database-record')).toBe(true);
    expect(result.findings.some(item => item.term === 'composition: novel grain')).toBe(false);
    expect(result.outcome).not.toBe('vegan');
  });

  test('research decision uses parsed medicine list and avoids unnecessary follow-up after animal evidence', async () => {
    const value = extraction();
    delete value.research;
    const requests: unknown[] = [];
    const fetcher: typeof fetch = (async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ status: 'completed', output: [
        { type: 'web_search_call', status: 'completed', action: { sources: [{ url: source, title: 'Product' }] } },
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify(value) }] },
      ] }));
    }) as typeof fetch;
    const provider = createOpenAIProvider({ baseUrl: 'https://api.openai.com/v1', model: 'supported', supportsVision: true }, fetcher);
    await provider.extract({ category: 'other', images: ['data:image/jpeg;base64,AA=='] });
    expect(requests).toHaveLength(1);
  });
});

test('follow-up research enriches the same source list without duplicating recipes or replacing visible parsing', async () => {
  const text = 'Ingredients: novel seed';
  const first: AIExtraction = { text, ingredients: ['novel seed'], complete: true, category: 'food', name: 'Seed product', brand: 'Maker',
    webCompositions: [{ url: source, text, complete: true, sourceType: 'manufacturer', productName: 'Seed product', brand: 'Maker' }] };
  const second: AIExtraction = { ...first, text: '', ingredients: [], complete: false,
    webCompositions: [{ ...first.webCompositions![0]!, ingredients: ['novel seed'] }], ingredientAssessments: [
      { term: 'novel seed', translatedTerm: 'novel seed', status: 'plant', explanation: 'A botanical seed.' },
    ] };
  let requests = 0;
  const fetcher: typeof fetch = (async () => new Response(JSON.stringify({ status: 'completed', output: [
    { type: 'web_search_call', status: 'completed', action: { sources: [{ url: source, title: 'Product' }] } },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify(++requests === 1 ? first : second) }] },
  ] }))) as unknown as typeof fetch;
  const provider = createOpenAIProvider({ baseUrl: 'https://api.openai.com/v1', model: 'supported' }, fetcher);
  const result = await provider.extract({ text, category: 'food', complete: true });
  expect(requests).toBe(2);
  expect(result.text).toBe(text);
  expect(result.ingredients).toEqual(['novel seed']);
  expect(result.webCompositions).toHaveLength(1);
  expect(result.webCompositions![0]!.ingredients).toEqual(['novel seed']);
});


test('structured photo parsing reuses AI transcription evidence without adding supplied text', async () => {
  const text = 'Ingredients: obscure seed';
  const result = await checkProduct({ images: ['data:image/jpeg;base64,AA=='], category: 'food' }, { mode: 'explicit', provider: { extract: async () => ({
    text, ingredients: ['obscure seed'], complete: true, category: 'food',
  }) } });
  expect(result.evidence).toHaveLength(1);
  expect(result.evidence[0]?.id).toBe('ai-extraction');
  expect(result.evidence[0]?.kind).toBe('ai_extraction');
  expect(result.findings[0]?.evidenceId).toBe('ai-extraction');
  expect(result.findings[0]?.explanation).toBe('The AI did not establish the origin of this ingredient.');
});

test('AI missing-assessment copy leaves unrelated unknown database evidence unchanged', () => {
  const input = { text: 'novel seed', complete: true, category: 'food' as const };
  const database = analyzeText({ ...input, text: 'obscure grain' });
  database.evidence = [{ ...database.evidence[0]!, id: 'database', kind: 'database' }];
  database.findings = database.findings.map(item => ({ ...item, evidenceId: 'database' }));
  const result = applyAIEvidence(mergeResults(analyzeText(input), database), input, { ...input, ingredients: ['novel seed'] }, true);
  expect(result.findings.find(item => item.term === 'novel seed')?.explanation).toBe('The AI did not establish the origin of this ingredient.');
  expect(result.findings.find(item => item.term === 'obscure grain')?.explanation).toBe('This term is not covered by the bundled rules.');
});

for (const locale of ['en', 'de'] as const) test(`empty front-photo ingredient list in ${locale} does not imply a failed source match`, async () => {
  const extracted: AIExtraction = { text: '', ingredients: [], complete: false, category: 'food', name: 'Front-only product' };
  expect(validateAIExtraction(extracted).ingredients).toEqual([]);
  const result = await checkProduct({ images: ['data:image/jpeg;base64,AA=='], category: 'food', locale }, {
    mode: 'explicit', provider: { extract: async () => extracted },
  });
  expect(result.findings).toEqual([]);
  expect(result.aiStatus).toBe('images');
  expect(result.warnings.some(message => /local splitting|Originalzusammensetzung|Aufteilung/.test(message))).toBe(false);
  const blank = analyzeText({ text: ' \n ', category: 'food', locale }, undefined, []);
  expect(blank.warnings.some(message => /local splitting|Originalzusammensetzung|Aufteilung/.test(message))).toBe(false);
});
