import { describe, expect, test } from 'bun:test';
import { analyzeText, checkProduct, createOpenAIProvider, validateAIExtraction } from '../src';
import type { AIExtraction, CheckInput } from '../src';

const composition = 'Trinkwasser, Rapsöl, 9% Erbsenprotein, Ackerbohnenprotein, Stärke, Erbsenfaser, Citrusfaser, Oligofructose, Leinsamenmehl (teilentölt), Flohsamenschalen, Speisesalz, natürliche Aromen, Säureregulatoren: Calciumlactat, Natriumacetate; Gewürze, Dextrose, Gewürzextrakte, Würze, Farbstoff: Eisenoxide und Eisenhydroxide';
const photo = 'data:image/jpeg;base64,AA==';
const label = { kind: 'vegan_certification' as const, name: 'V-Label', text: 'VEGAN' };
const check = (input: CheckInput, extraction: AIExtraction) => checkProduct(input, { mode: 'explicit', provider: { extract: async () => extraction } });

describe('composition and photo evidence regressions', () => {
  test('the full German list recognizes plants and minerals, retains only specific ambiguity, and never duplicates AI transcription', async () => {
    const result = await check({ text: composition, category: 'food', complete: true }, { text: composition, category: 'food', complete: true });
    expect(result.findings).toHaveLength(19);
    expect(result.findings.filter(item => item.status === 'unknown')).toEqual([]);
    expect(result.findings.filter(item => item.status === 'ambiguous').map(item => item.term)).toEqual(['natürliche aromen', 'würze']);
    expect(result.questions).toEqual(['Confirm the origin of: natürliche aromen, würze.']);
    expect(result.evidence).toHaveLength(2);
  });
  test('percentages and processing descriptors do not become ingredients, nested animal ingredients remain visible', () => {
    const plant = analyzeText({ text: 'Trinkwasser, 9,5% Erbsenprotein, Leinsamenmehl (teilentölt)', complete: true, category: 'food' });
    expect(plant.outcome).toBe('vegan');
    expect(plant.findings).toHaveLength(3);
    const animal = analyzeText({ text: 'Zutaten: Leinsamenmehl (Milch), Farbstoff: E120', category: 'food' });
    expect(animal.outcome).toBe('not_vegan');
    expect(animal.findings.filter(item => item.status === 'animal').map(item => item.ruleId)).toEqual(['milk', 'carmine']);
  });
  test('photo with a recognized explicit vegan label resolves the product while retaining flavour uncertainty', async () => {
    const result = await check({ text: composition, category: 'food', complete: true, images: [photo] }, {
      text: composition, category: 'food', complete: true, labelObservations: [label],
    });
    expect(result.outcome).toBe('vegan');
    expect(result.basis).toBe('packaging');
    expect(result.title).toBe('Vegan label visible');
    expect(result.findings.filter(item => item.status === 'ambiguous')).toHaveLength(2);
    expect(result.evidence.at(-1)?.verification).toBe('unverified');
    expect(result.aiStatus).toBe('images');
  });
  test('a photo can identify a labelled product without inventing composition', async () => {
    const result = await check({ images: [photo], category: 'other' }, { text: '', complete: false, category: 'household', name: 'Tissues', labelObservations: [label] });
    expect(result.identity.name).toBe('Tissues');
    expect(result.findings).toEqual([]);
    expect(result.basis).toBe('packaging');
  });
  test('labels cannot turn a text-only check into certification', async () => {
    const result = await check({ text: composition, category: 'food', complete: true }, { text: composition, category: 'food', complete: true, labelObservations: [label] });
    expect(result.outcome).toBe('uncertain');
    expect(result.evidence.some(item => item.claim)).toBe(false);
  });
  for (const observation of [
    { ...label, text: 'VEGETARIAN' }, { ...label, name: 'Nordic Swan', text: 'Eco label' },
    { ...label, name: 'Unknown certification', text: 'vegan' },
    { ...label, kind: 'vegan_claim' as const, text: 'not vegan' },
    { ...label, kind: 'vegan_claim' as const, text: 'non-vegan' },
  ]) test(`does not promote unsupported label ${observation.name}/${observation.text}`, async () => {
    const result = await check({ images: [photo] }, { text: '', complete: false, category: 'household', labelObservations: [observation] });
    expect(result.outcome).toBe('uncertain');
  });
  test('a label conflicting with animal content remains conflicting', async () => {
    const result = await check({ images: [photo], category: 'food' }, { text: 'milk', complete: true, category: 'food', labelObservations: [label] });
    expect(result.outcome).toBe('conflicting');
    expect(result.basis).toBe('insufficient');
  });
  test('AI can assess an unknown actual ingredient and attributes its reasoning', async () => {
    const result = await check({ text: 'sorghum flour', complete: true, category: 'food' }, { text: 'sorghum flour', complete: true, category: 'food', ingredientAssessments: [
      { term: 'sorghum flour', status: 'plant', explanation: 'Flour made from sorghum grain.' },
      { term: 'milk', status: 'plant', explanation: 'This invented entry does not occur in the supplied list.' },
    ] });
    expect(result.outcome).toBe('vegan');
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.explanation).toStartWith('AI assessment:');
    expect(result.evidence.at(-1)?.verification).toBe('unverified');
  });
  test('a plant compound assessment covers its exact parsed components from the actual composition', async () => {
    const text = 'oligofruktos* (fiber), torkade dadlar (dadlar, rismjöl)';
    const result = await check({ images: [photo], category: 'food' }, { text, complete: true, category: 'food', ingredientAssessments: [
      { term: 'oligofruktos* (fiber)', status: 'plant', explanation: 'Plant-derived dietary fiber.' },
      { term: 'torkade dadlar (dadlar, rismjöl)', status: 'plant', explanation: 'Dates and rice flour are plant ingredients.' },
    ] });
    expect(result.outcome).toBe('vegan');
    expect(result.findings.map(item => item.term)).toEqual(['oligofruktos', 'fiber', 'torkade dadlar', 'dadlar', 'rismjöl']);
    expect(result.findings.every(item => item.status === 'plant')).toBe(true);
  });
  test('invented compounds cannot resolve a matching unknown child', async () => {
    const result = await check({ images: [photo] }, { text: 'mystery ingredient', complete: true, category: 'food', ingredientAssessments: [
      { term: 'plant blend (mystery ingredient)', status: 'plant', explanation: 'This compound does not occur on the product.' },
    ] });
    expect(result.outcome).toBe('uncertain');
    expect(result.findings[0]?.status).toBe('unknown');
  });
  test('compound assessments never override known animal or ambiguous ingredients', async () => {
    const text = 'blend (milk, E471, rare seed)';
    const result = await check({ images: [photo] }, { text, complete: true, category: 'food', ingredientAssessments: [
      { term: text, status: 'plant', explanation: 'An incorrect whole-compound assessment.' },
    ] });
    expect(result.outcome).toBe('not_vegan');
    expect(result.findings.find(item => item.term === 'milk')?.status).toBe('animal');
    expect(result.findings.find(item => item.term === 'e471')?.status).toBe('ambiguous');
  });
  test('animal compound assessments describe the outer ingredient without marking every child animal', async () => {
    const text = 'blend (rare cereal, rare seed)';
    const result = await check({ images: [photo] }, { text, complete: true, category: 'food', ingredientAssessments: [
      { term: text, status: 'animal', explanation: 'The blend has animal content; this does not identify which component.' },
    ] });
    expect(result.findings.map(item => item.status)).toEqual(['animal', 'unknown', 'unknown']);
  });
  test('conflicting parent and child assessments remain unresolved', async () => {
    const text = 'blend (rare seed)';
    const result = await check({ images: [photo] }, { text, complete: true, category: 'food', ingredientAssessments: [
      { term: text, status: 'plant', explanation: 'Whole blend described as plant.' },
      { term: 'rare seed', status: 'animal', explanation: 'Conflicting child assessment.' },
    ] });
    expect(result.outcome).toBe('uncertain');
    expect(result.findings.find(item => item.term === 'rare seed')?.status).toBe('ambiguous');
  });
  test('AI cannot override known ambiguous rules or resolve unknown ingredients by claiming completeness', async () => {
    const result = await check({ text: 'E471, mystery ingredient', complete: true, category: 'food' }, { text: 'E471, mystery ingredient', complete: true, category: 'food', ingredientAssessments: [
      { term: 'E471', status: 'plant', explanation: 'Trust me.' },
    ] });
    expect(result.outcome).toBe('uncertain');
    expect(result.findings.map(item => item.status)).toEqual(['ambiguous', 'unknown']);
  });
  test('a photo cannot let the model drop ingredients from the supplied complete list', async () => {
    const result = await check({ text: 'water, mystery ingredient', complete: true, category: 'food', images: [photo] }, {
      text: 'water', complete: true, category: 'food',
    });
    expect(result.outcome).toBe('uncertain');
    expect(result.findings.some(item => item.term === 'mystery ingredient')).toBe(true);
  });
  test('the HTTP vision request includes actual image data and complete supplied text', async () => {
    let sent: unknown;
    const fetcher: typeof fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      sent = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ text: '', complete: false, category: 'household' }) } }] }), { status: 200 });
    }) as typeof fetch;
    const provider = createOpenAIProvider({ baseUrl: 'https://example.invalid/v1', model: 'vision', supportsVision: true }, fetcher);
    await provider.extract({ text: composition, images: [photo], complete: true, locale: 'de' });
    expect(sent).toMatchObject({ messages: [{ role: 'system' }, { role: 'user', content: [
      { type: 'text', text: JSON.stringify({ text: composition, complete: true, locale: 'de', market: 'DE' }) },
      { type: 'image_url', image_url: { url: photo } },
    ] }] });
  });
  test('a failed provider does not claim an accepted AI analysis', async () => {
    const result = await checkProduct({ images: [photo] }, { mode: 'explicit', provider: { extract: async () => { throw new Error('Connection failed'); } } });
    expect(result.usedAI).toBe(false);
    expect(result.aiStatus).toBe('failed');
  });
  test('unconfigured photo check explains that no AI saw the image', async () => {
    const result = await checkProduct({ images: [photo] }, { mode: 'explicit' });
    expect(result.usedAI).toBe(false);
    expect(result.aiStatus).toBe('unconfigured');
    expect(result.warnings).toContain('AI did not analyze this photo: choose a model in Settings.');
  });
  test('validates optional evidence limits', () => {
    const base = { text: '', complete: false, category: 'food' };
    expect(() => validateAIExtraction({ ...base, labelObservations: Array(6).fill(label) })).toThrow();
    expect(() => validateAIExtraction({ ...base, ingredientAssessments: [{ term: 'water', status: 'vegan', explanation: 'x' }] })).toThrow();
  });
});
