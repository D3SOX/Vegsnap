import { describe, expect, test } from 'bun:test';
import { lookupMatspar, retainMatsparComposition } from '../src/matspar-catalogue';
import { checkProduct } from '../src/check';
import { createOpenAIProvider } from '../src/provider';
import type { AIExtraction, CheckInput } from '../src/types';

const ingredients = 'INGREDIENSER: Kikärtor* 58%, vatten, rapsolja, SESAMPASTA 5,8%, röd paprika, salt, surhetsreglerande medel (E 330), chili 0,5%, paprikapulver, vitlökspulver, konserveringsmedel (E 202). *Ursprung: Se till vänster.';
const extraction: AIExtraction = { text: '', complete: false, category: 'food', name: 'Hummus med chili', brand: 'Coop',
  packaging: { language: 'sv', country: 'Sverige', quantity: '200 g', variant: 'chili' } };
const input: CheckInput = { images: ['data:image/jpeg;base64,AA=='] };
const listing = (overrides: Record<string, unknown> = {}) => ({ name: 'Hummus chili', brand: 'Coop', weight_pretty: '200g', slug: 'produkt/hummus-chili-200g-coop', ...overrides });
function fetcherWith(products: unknown[], full: Record<string, unknown> = listing({ ingredients })) {
  const requests: { url: string; init?: RequestInit }[] = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(url), init });
    const body = JSON.parse(String(init?.body)) as { slug: string };
    return new Response(JSON.stringify(body.slug === '/kategori' ? { type: 'category', payload: { products } } : { type: 'product', payload: full }), { status: 200 });
  }) as typeof fetch;
  return { fetcher, requests };
}

describe('Matspar catalogue fallback', () => {
  test('catalogue provenance supports only composition and preserves independent contact and company evidence', () => {
    const url = 'https://www.matspar.se/produkt/hummus-chili-200g-coop';
    const independentUrl = 'https://maker.example/contact';
    const catalogue = { url, text: ingredients, productName: 'Hummus chili', brand: 'Coop', quantity: '200g' };
    const original: AIExtraction = { ...extraction,
      webClaims: [{ url, quote: 'Vegan.', claim: 'vegan', sourceType: 'manufacturer', productName: extraction.name!, brand: 'Coop' }],
      contact: { productName: extraction.name!, brand: 'Coop', sourceUrl: independentUrl, url: independentUrl },
      companyAssessment: { brand: 'Coop', company: 'Parent', scope: 'parent', verdict: 'inconclusive', summary: 'Uncertain.',
        categories: [], sources: [{ url: independentUrl, title: 'Parent', quote: 'Ownership.' }], ownershipSourceUrl: independentUrl },
    };
    for (const field of ['sourceUrl', 'url'] as const) {
      const result = retainMatsparComposition({ ...original, contact: { ...original.contact!, [field]: url } }, catalogue);
      expect(result.contact).toBeUndefined();
      expect(result.webClaims).toEqual([]);
      expect(result.webCompositions?.[0]?.text).toBe(ingredients);
    }
    for (const companyAssessment of [
      { ...original.companyAssessment!, ownershipSourceUrl: url },
      { ...original.companyAssessment!, sources: [{ url, title: 'Parent', quote: 'Ownership.' }] },
    ]) expect(retainMatsparComposition({ ...original, companyAssessment }, catalogue).companyAssessment).toBeUndefined();
    const independent = retainMatsparComposition(original, catalogue);
    expect(independent.contact).toEqual(original.contact);
    expect(independent.companyAssessment).toEqual(original.companyAssessment);
  });
  test('retains the exact 200 g composition and source from a matched full product record', async () => {
    const candidate = listing();
    const split = ['Kikärtor', 'vatten', 'rapsolja', 'SESAMPASTA', 'röd paprika', 'salt', 'E 330', 'chili', 'paprikapulver', 'vitlökspulver', 'E 202'];
    const { fetcher, requests } = fetcherWith([candidate]);
    const initial: AIExtraction = { ...extraction, webCompositions: [{ url: 'https://www.matspar.se/produkt/hummus-chili-200g-coop', text: ingredients,
      ingredients: split, complete: false, sourceType: 'retailer', productName: 'Hummus chili', brand: 'Coop' }] };
    const found = await lookupMatspar(initial, input, fetcher);
    expect(found?.text).toBe(ingredients);
    const result = found && retainMatsparComposition(initial, found);
    expect(result?.text).toBe('');
    expect(result?.complete).toBe(false);
    expect(result?.name).toBe('Hummus med chili');
    expect(result?.brand).toBe('Coop');
    expect(result?.webCompositions?.[0]).toMatchObject({ url: 'https://www.matspar.se/produkt/hummus-chili-200g-coop',
      ingredients: split.map(term => term.toLowerCase()), complete: true, sourceType: 'retailer', productName: 'Hummus med chili', brand: 'Coop' });
    expect(result?.research?.sources).toContainEqual({ url: 'https://www.matspar.se/produkt/hummus-chili-200g-coop', title: 'Matspar: Hummus chili' });
    expect(requests).toHaveLength(2);
    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({ slug: '/kategori', query: { q: 'Coop Hummus med chili' } });
    expect(JSON.parse(String(requests[1]?.init?.body))).toEqual({ slug: '/produkt/hummus-chili-200g-coop', query: {} });
    expect(requests.every(request => request.init?.credentials === 'omit' && request.init?.redirect === 'error')).toBe(true);
  });

  test('rejects partial model splits so local composition splitting retains unknown leftovers', async () => {
    const candidate = listing();
    const { fetcher } = fetcherWith([candidate]);
    const found = await lookupMatspar({ ...extraction, ingredientAssessments: [{ term: 'Kikärtor', status: 'plant', explanation: 'Plant.' }] }, input, fetcher);
    const result = found && retainMatsparComposition({ ...extraction, ingredientAssessments: [{ term: 'Kikärtor', status: 'plant', explanation: 'Plant.' }] }, found);
    expect(result?.webCompositions?.[0]?.ingredients).toBeUndefined();
    expect(result?.ingredientAssessments).toEqual([]);
  });

  test('rejects ambiguous candidates, wrong quantities, and non-food, non-Swedish or barcoded products', async () => {
    const candidate = listing();
    for (const entries of [[candidate, { ...candidate }], [listing({ weight_pretty: '250g' })]]) {
      const { fetcher } = fetcherWith(entries);
      expect(await lookupMatspar(extraction, input, fetcher)).toBeUndefined();
    }
    for (const [record, checkInput] of [
      [{ ...extraction, category: 'cosmetics' as const }, input],
      [{ ...extraction, packaging: { ...extraction.packaging, language: 'en' } }, input],
      [extraction, { ...input, barcode: '4006381333931' }],
    ] as const) {
      const { fetcher, requests } = fetcherWith([candidate]);
      expect(await lookupMatspar(record, checkInput, fetcher)).toBeUndefined();
      expect(requests).toHaveLength(0);
    }
  });

  test('rejects malformed slugs and changed full product identity', async () => {
    for (const full of [listing({ slug: 'produkt/other-slug' }), listing({ brand: 'Other' }), listing({ weight_pretty: '250g' })]) {
      const { fetcher } = fetcherWith([listing()], full);
      expect(await lookupMatspar(extraction, input, fetcher)).toBeUndefined();
    }
    const { fetcher } = fetcherWith([listing({ slug: 'https://evil.example/product' })]);
    expect(await lookupMatspar(extraction, input, fetcher)).toBeUndefined();
  });

  test('keeps the catalogue evidence when the optional AI research follow-up fails', async () => {
    const calls: RequestInit[] = [];
    const aiFetcher = (async (_url: string | URL | Request, init?: RequestInit) => {
      calls.push(init ?? {});
      if (calls.length > 1) return new Response('failed', { status: 503 });
      const initial: AIExtraction = { ...extraction, text: '', complete: false };
      return new Response(JSON.stringify({ status: 'completed', output: [
        { type: 'web_search_call', status: 'completed', action: { type: 'search', sources: [] } },
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify(initial), annotations: [] }] },
      ] }), { status: 200 });
    }) as unknown as typeof fetch;
    const { fetcher: catalogueFetcher } = fetcherWith([listing()]);
    const provider = createOpenAIProvider({ baseUrl: 'https://api.openai.com/v1', model: 'selected', supportsVision: true }, aiFetcher, catalogueFetcher);
    const result = await checkProduct(input, { mode: 'explicit', provider });
    expect(calls).toHaveLength(2);
    expect(result.evidence.some(item => item.url === 'https://www.matspar.se/produkt/hummus-chili-200g-coop' && item.excerpt === ingredients)).toBe(true);
    expect(result.findings.some(item => item.term === 'e 202' && item.status === 'unknown')).toBe(true);
    expect(result.evidence.some(item => item.title.includes('AI transcription') && item.excerpt === ingredients)).toBe(false);
  });

  test('a successful follow-up parses the full fetched composition without changing the photo transcription', async () => {
    const split = ['Kikärtor', 'vatten', 'rapsolja', 'SESAMPASTA', 'röd paprika', 'salt', 'E 330', 'chili', 'paprikapulver', 'vitlökspulver', 'E 202'];
    const assessments = split.map(term => ({ term, status: term === 'E 202' ? 'unknown' as const : 'plant' as const, explanation: 'Assessed from the source term.' }));
    let calls = 0;
    const aiFetcher = (async () => {
      calls++;
      const value: AIExtraction = calls === 1 ? { ...extraction, text: '', complete: false } : {
        ...extraction, text: '', complete: false, ingredients: undefined, ingredientAssessments: assessments,
        webCompositions: [{ url: 'https://www.matspar.se/produkt/hummus-chili-200g-coop', text: ingredients, ingredients: split,
          complete: true, sourceType: 'retailer', productName: extraction.name!, brand: extraction.brand! }],
      };
      return new Response(JSON.stringify({ status: 'completed', output: [
        { type: 'web_search_call', status: 'completed', action: { type: 'search', sources: [{ url: 'https://maker.example/other' }] } },
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify(value), annotations: [] }] },
      ] }), { status: 200 });
    }) as unknown as typeof fetch;
    const { fetcher: catalogueFetcher } = fetcherWith([listing()]);
    const provider = createOpenAIProvider({ baseUrl: 'https://api.openai.com/v1', model: 'selected', supportsVision: true }, aiFetcher, catalogueFetcher);
    const extracted = await provider.extract(input);
    expect(calls).toBe(2);
    expect(extracted.text).toBe('');
    expect(extracted.complete).toBe(false);
    expect(extracted.name).toBe('Hummus med chili');
    expect(extracted.webCompositions?.[0]?.ingredients).toHaveLength(11);
    expect(extracted.research?.sources).toContainEqual({ url: 'https://maker.example/other', title: '' });
    const result = await checkProduct(input, { mode: 'explicit', provider: { supportsWebSearch: true, extract: async () => extracted } });
    expect(result.evidence.some(item => item.url === 'https://www.matspar.se/produkt/hummus-chili-200g-coop' && item.excerpt === ingredients)).toBe(true);
    expect(result.findings).toHaveLength(11);
    expect(result.findings.find(item => item.term === 'e 202')?.status).toBe('unknown');
    expect(result.outcome).toBe('uncertain');
  });

  test('a genuinely different follow-up identity cannot assess the fetched product', async () => {
    let calls = 0;
    const aiFetcher = (async () => {
      const value: AIExtraction = ++calls === 1 ? extraction : { ...extraction, name: 'Other hummus', brand: 'Other',
        ingredientAssessments: ['water', 'unfamiliar additive'].map(term => ({ term, status: 'plant', explanation: 'Unrelated assessment.' })) };
      return new Response(JSON.stringify({ status: 'completed', output: [
        { type: 'web_search_call', status: 'completed', action: { type: 'search', sources: [] } },
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify(value) }] },
      ] }));
    }) as unknown as typeof fetch;
    const { fetcher: catalogueFetcher } = fetcherWith([listing()], listing({ ingredients: 'water, unfamiliar additive' }));
    const provider = createOpenAIProvider({ baseUrl: 'https://api.openai.com/v1', model: 'selected', supportsVision: true }, aiFetcher, catalogueFetcher);
    const result = await checkProduct(input, { mode: 'explicit', provider });
    expect(result.outcome).toBe('uncertain');
    expect(result.findings.find(item => item.term === 'unfamiliar additive')?.status).toBe('unknown');
    expect(result.findings.some(item => item.explanation === 'Unrelated assessment.')).toBe(false);
    expect(result.evidence.some(item => item.excerpt === 'water, unfamiliar additive' && item.url?.includes('matspar'))).toBe(true);
  });
  test('an incomplete follow-up ingredient split cannot resolve leftover terms or establish vegan status', async () => {
    let calls = 0;
    const aiFetcher = (async () => {
      calls++;
      const value: AIExtraction = calls === 1 ? { ...extraction, text: '', complete: false } : {
        ...extraction, text: '', complete: false,
        ingredientAssessments: [{ term: 'E 202', status: 'plant', explanation: 'Plant-derived.' }],
        webCompositions: [{ url: 'https://www.matspar.se/produkt/hummus-chili-200g-coop', text: ingredients, ingredients: ['Kikärtor'],
          complete: true, sourceType: 'retailer', productName: extraction.name!, brand: extraction.brand! }],
      };
      return new Response(JSON.stringify({ status: 'completed', output: [
        { type: 'web_search_call', status: 'completed', action: { type: 'search', sources: [] } },
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify(value), annotations: [] }] },
      ] }), { status: 200 });
    }) as unknown as typeof fetch;
    const { fetcher: catalogueFetcher } = fetcherWith([listing()]);
    const provider = createOpenAIProvider({ baseUrl: 'https://api.openai.com/v1', model: 'selected', supportsVision: true }, aiFetcher, catalogueFetcher);
    const result = await checkProduct(input, { mode: 'explicit', provider });
    expect(result.outcome).toBe('uncertain');
    expect(result.findings.find(item => item.term === 'e 202')?.status).toBe('unknown');
    expect(result.evidence.some(item => item.excerpt === ingredients && item.url?.includes('matspar'))).toBe(true);
  });
});
