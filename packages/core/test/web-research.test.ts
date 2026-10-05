import { describe, expect, test } from 'bun:test';
import { checkProduct, createOpenAIProvider, parseAIExtraction } from '../src';
import type { AIExtraction, CheckInput } from '../src';

const url = 'https://maker.example/products/tissues';
const base: AIExtraction = { text: '', complete: false, category: 'household', name: 'Soft tissues', brand: 'Maker' };
const claim = { url, quote: 'Soft tissues are vegan.', claim: 'vegan' as const, sourceType: 'manufacturer' as const, productName: 'Soft tissues', brand: 'Maker' };
const research = { searched: true, sources: [{ url, title: 'Soft tissues | Maker' }] };
const input: CheckInput = { images: ['data:image/jpeg;base64,AA=='] };
const check = (extraction: AIExtraction, checkInput = input) => checkProduct(checkInput, { mode: 'explicit', provider: { supportsWebSearch: true, extract: async () => extraction } });
const envelope = (text: unknown, output: unknown[] = []) => ({ status: 'completed', output: [...output,
  { type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: JSON.stringify(text), annotations: [{ type: 'url_citation', url, title: 'Soft tissues | Maker' }] }] },
] });
const reply = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

describe('grounded web research', () => {
  test('official OpenAI uses bounded Responses search and transports only envelope provenance', async () => {
    let sent: unknown;
    let endpoint = '';
    const fetcher = (async (target: string | URL | Request, init?: RequestInit) => {
      endpoint = String(target); sent = JSON.parse(String(init?.body));
      return reply(envelope({ ...base, webClaims: [claim] }, [{ type: 'web_search_call', status: 'completed', action: { type: 'search', sources: [{ type: 'url', url }] } }]));
    }) as unknown as typeof fetch;
    const provider = createOpenAIProvider({ baseUrl: 'https://api.openai.com/v1', model: 'selected', supportsVision: true }, fetcher);
    const result = await checkProduct(input, { mode: 'explicit', provider });
    expect(endpoint).toBe('https://api.openai.com/v1/responses');
    expect(sent).toMatchObject({ store: false, max_tool_calls: 3, tools: [{ type: 'web_search' }], include: ['web_search_call.action.sources'], input: [{ content: [{ type: 'input_text' }, { type: 'input_image', image_url: input.images?.[0] }] }] });
    expect(result.webSearchStatus).toBe('searched');
    expect(result.outcome).toBe('vegan');
    expect(result.basis).toBe('manufacturer');
    expect(result.evidence.at(-1)).toMatchObject({ url, verification: 'unverified' });
  });
  test('a URL in model JSON alone cannot establish that search happened', async () => {
    const result = await check({ ...base, webClaims: [claim] });
    expect(result.outcome).toBe('uncertain');
    expect(result.webSearchStatus).toBe('not_used');
    expect(result.evidence.some(item => item.url === url)).toBe(false);
    expect(() => parseAIExtraction(JSON.stringify({ ...base, research }))).toThrow('invalid extraction');
  });
  test('a completed direct page opening supplies real provenance without an inline JSON citation', async () => {
    const fetcher = (async () => reply({ status: 'completed', output: [
      { type: 'web_search_call', status: 'completed', action: { type: 'open_page', url } },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify({ ...base, webClaims: [claim] }), annotations: [] }] },
    ] })) as unknown as typeof fetch;
    const provider = createOpenAIProvider({ baseUrl: 'https://api.openai.com/v1', model: 'selected', supportsVision: true }, fetcher);
    const result = await checkProduct(input, { mode: 'explicit', provider });
    expect(result.outcome).toBe('vegan');
    expect(result.evidence.at(-1)?.url).toBe(url);
  });
  test('citation annotations without completed search do not prove search happened', async () => {
    const fetcher = (async () => reply(envelope({ ...base, webClaims: [claim] }))) as unknown as typeof fetch;
    const provider = createOpenAIProvider({ baseUrl: 'https://api.openai.com/v1', model: 'selected', supportsVision: true }, fetcher);
    const result = await checkProduct(input, { mode: 'explicit', provider });
    expect(result.outcome).toBe('uncertain');
    expect(result.webSearchStatus).toBe('not_used');
  });
  test('model-authored research inside Responses output cannot forge source metadata', async () => {
    const fetcher = (async () => reply(envelope({ ...base, webClaims: [claim], research }))) as unknown as typeof fetch;
    const provider = createOpenAIProvider({ baseUrl: 'https://api.openai.com/v1', model: 'selected', supportsVision: true }, fetcher);
    const result = await checkProduct(input, { mode: 'explicit', provider });
    expect(result.aiStatus).toBe('failed');
    expect(result.usedAI).toBe(false);
    expect(result.outcome).toBe('uncertain');
  });
  for (const badClaim of [{ ...claim, url: 'https://fabricated.example/product' }, { ...claim, productName: 'All products' }, { ...claim, brand: 'Other maker' }]) {
    test(`rejects mismatched researched claim ${JSON.stringify(badClaim)}`, async () => {
      const result = await check({ ...base, webClaims: [badClaim], research });
      expect(result.outcome).toBe('uncertain');
      expect(result.evidence.some(item => item.claim)).toBe(false);
    });
  }
  test('web claims cannot override a different explicitly supplied product identity', async () => {
    const result = await check({ ...base, webClaims: [claim], research }, { ...input, brand: 'Different' });
    expect(result.outcome).toBe('uncertain');
  });
  test('consulted sources stay visible when a claim cannot establish an exact product match', async () => {
    const result = await check({ ...base, webClaims: [{ ...claim, productName: 'Another variant' }], research });
    expect(result.outcome).toBe('uncertain');
    expect(result.evidence.at(-1)).toMatchObject({ kind: 'ai_extraction', url, verification: 'unverified',
      excerpt: 'Consulted during web research; no matching product-specific claim was established.' });
    expect(result.evidence.at(-1)?.claim).toBeUndefined();
  });
  test('consulted sources are bounded, deduplicated, and visible even without identified product identity', async () => {
    const result = await check({ text: '', complete: false, category: 'other', research: { searched: true,
      sources: [research.sources[0]!, research.sources[0]!, ...Array.from({ length: 4 }, (_, index) => ({ url: `https://source.example/${index}`, title: `Source ${index}` }))] } });
    expect(result.evidence.filter(item => item.url)).toHaveLength(3);
    expect(result.outcome).toBe('uncertain');
  });
  test('animal composition conflicting with a manufacturer statement remains conflicting', async () => {
    const result = await check({ ...base, text: 'gelatin', complete: true, webClaims: [claim], research });
    expect(result.outcome).toBe('conflicting');
    expect(result.basis).toBe('insufficient');
  });
  test('certification website is an AI-read source, not an independently checked registry', async () => {
    const result = await check({ ...base, webClaims: [{ ...claim, sourceType: 'certification' }], research });
    expect(result.outcome).toBe('vegan');
    expect(result.basis).toBe('research');
    expect(result.evidence.at(-1)?.verification).toBe('unverified');
  });
  test('compatible providers report unsupported search and cannot inject research JSON', async () => {
    const provider = createOpenAIProvider({ baseUrl: 'https://compatible.example/v1', model: 'selected', supportsVision: true }, (async () => reply({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(base) } }] })) as unknown as typeof fetch);
    const result = await checkProduct(input, { mode: 'explicit', provider });
    expect(result.webSearchStatus).toBe('unsupported');
    expect(result.outcome).toBe('uncertain');
  });
  test('background and offline checks never invoke search-capable providers', async () => {
    let requests = 0;
    const provider = createOpenAIProvider({ baseUrl: 'https://api.openai.com/v1', model: 'selected', supportsVision: true }, (async () => { requests++; return reply(envelope(base)); }) as unknown as typeof fetch);
    await checkProduct(input, { mode: 'background', provider });
    await checkProduct(input, { mode: 'explicit', offline: true, provider });
    expect(requests).toBe(0);
  });
});

describe('researched product composition', () => {
  const granola = { text: '', complete: false, category: 'food' as const, name: 'Granola Kakao & Hallon', brand: 'Paulúns' };
  const composition = { url, text: 'havregryn, kakao, hallon', complete: true, sourceType: 'manufacturer' as const, productName: granola.name, brand: granola.brand };
  const ingredientAssessments = ['havregryn', 'kakao', 'hallon'].map(term => ({ term, status: 'plant' as const, explanation: 'Plant ingredient.' }));
  test('front photo can use a retrieved full composition without pretending it was visible', async () => {
    const result = await check({ ...granola, webCompositions: [composition], ingredientAssessments, research });
    expect(result.outcome).toBe('vegan');
    expect(result.basis).toBe('composition');
    expect(result.evidence.some(item => item.url === url && item.excerpt === composition.text)).toBe(true);
    expect(result.evidence.some(item => item.id === 'ai-extraction')).toBe(false);
  });
  test('the live Swedish granola response aligns compound assessments with source components', async () => {
    const text = 'HAVRE, oligofruktos* (fiber), rapsolja, DINKEL, äppeljuicekoncentrat, torkade dadlar (dadlar, rismjöl), kakao, kokos, torkade hallon 1,5 %, havssalt. Kan innehålla spår av JORDNÖTTER och NÖTTER.';
    const terms = ['HAVRE', 'oligofruktos* (fiber)', 'rapsolja', 'DINKEL', 'äppeljuicekoncentrat', 'torkade dadlar (dadlar, rismjöl)', 'kakao', 'kokos', 'torkade hallon 1,5 %', 'havssalt'];
    const result = await check({ ...granola, webCompositions: [{ ...composition, text, sourceType: 'retailer' }], research,
      ingredientAssessments: terms.map(term => ({ term, status: 'plant', explanation: 'Plant or mineral ingredient; compound components are plant-derived.' })) });
    expect(result.outcome).toBe('vegan');
    expect(result.basis).toBe('composition');
    expect(result.findings).toHaveLength(13);
    expect(result.findings.every(item => item.status === 'plant')).toBe(true);
    expect(result.crossContact).toHaveLength(1);
    expect(result.evidence.find(item => item.id === 'web-composition-0')).toMatchObject({ excerpt: text, url, title: 'Retailer composition (AI)' });
    expect(result.evidence.some(item => item.id === 'ai-extraction')).toBe(false);
  });
  test('a searched meat-filled ravioli composition gives an animal finding', async () => {
    const result = await check({ ...granola, name: 'Ravioli in Tomatensauce', brand: 'MAGGI', research,
      webCompositions: [{ ...composition, productName: 'Ravioli in Tomatensauce', brand: 'MAGGI', text: 'Wasser, Weizenmehl, Schweinefleisch' }] });
    expect(result.outcome).toBe('not_vegan');
    expect(result.findings.some(item => item.status === 'animal')).toBe(true);
  });
  test('researched composition still requires actual source provenance and exact identity', async () => {
    for (const changes of [{ research: undefined }, { webCompositions: [{ ...composition, url: 'https://invented.example/list' }] }, { webCompositions: [{ ...composition, productName: 'Other variant' }] }, { webCompositions: [{ ...composition, brand: 'Other' }] }]) {
      const result = await check({ ...granola, webCompositions: [composition], ingredientAssessments, research, ...changes });
      expect(result.outcome).toBe('uncertain');
      expect(result.evidence.some(item => item.id.startsWith('web-composition-'))).toBe(false);
    }
  });
  test('an incomplete retrieved plant list cannot establish vegan composition', async () => {
    const result = await check({ ...granola, webCompositions: [{ ...composition, complete: false }], ingredientAssessments, research });
    expect(result.outcome).toBe('uncertain');
  });
  test('retailer composition is labelled and conflicting manufacturer evidence is retained', async () => {
    const retailer = { ...composition, sourceType: 'retailer' as const };
    const result = await check({ ...granola, webCompositions: [retailer], ingredientAssessments, research });
    expect(result.outcome).toBe('vegan');
    expect(result.basis).toBe('composition');
    expect(result.evidence.find(item => item.id === 'web-composition-0')).toMatchObject({ title: 'Retailer composition (AI)', verification: 'unverified' });
    const conflict = await check({ ...granola, webCompositions: [composition, { ...retailer, text: 'milk' }], ingredientAssessments, research });
    expect(conflict.outcome).toBe('conflicting');
    expect(conflict.evidence.filter(item => item.id.startsWith('web-composition-') && !item.id.endsWith('-assessment'))).toHaveLength(2);
  });
  test('web meat ingredients conflict with a vegan mark on the photo', async () => {
    const result = await check({ ...granola, webCompositions: [{ ...composition, text: 'Schweinefleisch' }],
      labelObservations: [{ kind: 'vegan_claim', name: 'Packaging', text: 'vegan' }], research });
    expect(result.outcome).toBe('conflicting');
    expect(result.findings.some(item => item.status === 'animal')).toBe(true);
  });
  test('invalid or oversized retrieved compositions are rejected', () => {
    for (const webCompositions of [[{ ...composition, complete: 'yes' }], [{ ...composition, text: '' }], [{ ...composition, text: 'x'.repeat(20_001) }], Array(4).fill(composition)]) {
      expect(() => parseAIExtraction(JSON.stringify({ ...granola, webCompositions }))).toThrow('researched composition');
    }
  });
  test('failed required research keeps the completed photo result and explains the missing research', async () => {
    let requests = 0;
    const provider = createOpenAIProvider({ baseUrl: 'https://api.openai.com/v1', model: 'selected', supportsVision: true }, (async () => ++requests === 1 ? reply(envelope(granola)) : new Response('', { status: 503 })) as unknown as typeof fetch);
    const result = await checkProduct(input, { mode: 'explicit', provider });
    expect(requests).toBe(2);
    expect(result.usedAI).toBe(true);
    expect(result.aiStatus).toBe('images');
    expect(result.identity.name).toBe(granola.name);
    expect(result.warnings).toContain('Web research did not complete; the available photo or text evidence was kept.');
  });
  test('overflow preserves the first response instead of dropping a later contradictory assessment', async () => {
    let requests = 0;
    const first = { ...granola, ingredientAssessments: Array.from({ length: 100 }, (_, i) => ({ term: `ingredient${i}`, status: 'plant' as const, explanation: 'Plant origin.' })) };
    const second = { ...granola, webCompositions: [composition], ingredientAssessments: [{ term: 'ingredient0', status: 'animal', explanation: 'Conflicting origin.' }] };
    const provider = createOpenAIProvider({ baseUrl: 'https://api.openai.com/v1', model: 'selected', supportsVision: true },
      (async () => reply(++requests === 1 ? envelope(first) : envelope(second, [{ type: 'web_search_call', status: 'completed', action: { sources: [{ url }] } }]))) as unknown as typeof fetch);
    const extracted = await provider.extract(input);
    expect(requests).toBe(2);
    expect(extracted.ingredientAssessments).toEqual(first.ingredientAssessments);
    expect(extracted.webCompositions).toBeUndefined();
    expect(extracted.research?.searched).toBe(false);
  });
  test('research follow-up cannot replace the observed product identity or transcription', async () => {
    let requests = 0;
    const provider = createOpenAIProvider({ baseUrl: 'https://api.openai.com/v1', model: 'selected', supportsVision: true }, (async () => reply(++requests === 1 ? envelope(granola) : envelope({ ...granola, name: 'Other granola', text: 'fabricated visible text', webCompositions: [composition] }, [{ type: 'web_search_call', status: 'completed', action: { sources: [{ url }] } }]))) as unknown as typeof fetch);
    const result = await checkProduct(input, { mode: 'explicit', provider });
    expect(result.identity.name).toBe(granola.name);
    expect(result.outcome).toBe('uncertain');
    expect(result.evidence.some(item => item.excerpt.includes('fabricated'))).toBe(false);
  });
  test('OpenAI follows a recognized front photo with one required identity-only search', async () => {
    const requests: Record<string, unknown>[] = [];
    const provider = createOpenAIProvider({ baseUrl: 'https://api.openai.com/v1', model: 'selected', supportsVision: true }, (async (_target: string | URL | Request, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)));
      return reply(requests.length === 1 ? envelope(granola) : envelope({ ...granola, webCompositions: [composition], ingredientAssessments }, [{ type: 'web_search_call', status: 'completed', action: { sources: [{ url }] } }]));
    }) as unknown as typeof fetch);
    const result = await checkProduct(input, { mode: 'explicit', provider });
    expect(requests).toHaveLength(2);
    expect(requests[1]).toMatchObject({ tool_choice: 'required' });
    expect(JSON.stringify(requests[1])).not.toContain('data:image/');
    expect(result.outcome).toBe('vegan');
  });
});
