import promptData from '../../../contracts/ai-extraction-prompt.json';
import type { AIExtraction, Category, CheckInput, ProviderAdapter, ProviderConfig } from './types';
import { readBoundedText } from './http';
import { acceptsImages } from './model-capabilities';
import { analyzeText, parseSourceIngredients, safeSourceUrl } from './analyze';
import { applyAIEvidence } from './ai-evidence';
import { applyWebEvidence } from './web-evidence';
import { parseManufacturerContact } from './manufacturer-contact';
import { parseCompanyAssessment, sourcedCompanyAssessment } from './company-assessment';
import { normalizeBarcode } from './barcode';
import { selectProductCountry } from './market';
import { lookupMatspar, retainMatsparComposition, matchesMatsparIdentity } from './matspar-catalogue';

export const EXTRACTION_PROMPT = promptData.prompt;
export const PROVIDER_PRESETS = [
  { id: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1' },
  { id: 'openrouter', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1' },
  { id: 'gemini', name: 'Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai' },
  { id: 'ollama', name: 'Ollama', baseUrl: 'http://127.0.0.1:11434/v1' },
  { id: 'custom', name: 'Custom', baseUrl: '' },
] as const;
const categories: Category[] = ['food', 'drink', 'cosmetics', 'household', 'clothing', 'shoes', 'other'];
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function validIngredientList(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= 100 && value.every(term => typeof term === 'string' && Boolean(term.trim()) && term.length <= 300);
}
export function validateAIExtraction(value: unknown, options: { allowResearch?: boolean } = {}): AIExtraction {
  const keys = ['text', 'ingredients', 'complete', 'category', 'name', 'brand', 'barcode', 'packaging', 'ingredientAssessments', 'labelObservations', 'webClaims', 'webCompositions', 'contact', 'companyAssessment', ...(options.allowResearch ? ['research'] : [])];
  if (!object(value) || Object.keys(value).some(key => !keys.includes(key)) ||
    typeof value.text !== 'string' || value.text.length > 30_000 || typeof value.complete !== 'boolean' ||
    typeof value.category !== 'string' || !categories.includes(value.category as Category) ||
    ['name', 'brand', 'barcode'].some(key => value[key] !== undefined && (typeof value[key] !== 'string' || value[key].length > 300)) ||
    typeof value.barcode === 'string' && !/^(?:\d{8}|\d{12}|\d{13}|\d{14})$/.test(value.barcode)) {
    throw new Error('AI returned invalid extraction data.');
  }
  if (value.packaging !== undefined && (!object(value.packaging) || !Object.keys(value.packaging).length ||
    Object.entries(value.packaging).some(([key, clue]) => !['language', 'country', 'variant', 'quantity'].includes(key) ||
      typeof clue !== 'string' || !clue.trim() || clue.length > 300))) {
    throw new Error('AI returned invalid packaging clues.');
  }
  if (value.ingredients !== undefined && !validIngredientList(value.ingredients)) throw new Error('AI returned invalid parsed ingredients.');
  if (!value.text.trim() && value.complete) throw new Error('AI marked an empty composition as complete.');
  if (value.ingredientAssessments !== undefined && (!Array.isArray(value.ingredientAssessments) || value.ingredientAssessments.length > 100 ||
    value.ingredientAssessments.some(item => !object(item) || Object.keys(item).some(key => !['term', 'translatedTerm', 'status', 'explanation'].includes(key)) ||
      typeof item.term !== 'string' || !item.term.trim() || item.term.length > 300 ||
      item.translatedTerm !== undefined && (typeof item.translatedTerm !== 'string' || !item.translatedTerm.trim() || item.translatedTerm.length > 300) ||
      !['plant', 'animal', 'ambiguous', 'unknown'].includes(String(item.status)) ||
      typeof item.explanation !== 'string' || !item.explanation.trim() || item.explanation.length > 1000))) {
    throw new Error('AI returned invalid ingredient assessments.');
  }
  if (value.labelObservations !== undefined && (!Array.isArray(value.labelObservations) || value.labelObservations.length > 5 ||
    value.labelObservations.some(item => !object(item) || Object.keys(item).some(key => !['kind', 'name', 'text'].includes(key)) ||
      !['vegan_certification', 'vegan_claim'].includes(String(item.kind)) ||
      typeof item.name !== 'string' || !item.name.trim() || item.name.length > 100 ||
      typeof item.text !== 'string' || !item.text.trim() || item.text.length > 300))) {
    throw new Error('AI returned invalid label observations.');
  }
  if (value.webClaims !== undefined && (!Array.isArray(value.webClaims) || value.webClaims.length > 5 ||
    value.webClaims.some(item => !object(item) || Object.keys(item).some(key => !['url', 'quote', 'claim', 'sourceType', 'productName', 'brand'].includes(key)) ||
      typeof item.url !== 'string' || item.url.length > 2000 || !safeSourceUrl(item.url) ||
      typeof item.quote !== 'string' || !item.quote.trim() || item.quote.length > 1000 ||
      !['vegan', 'not_vegan'].includes(String(item.claim)) || !['manufacturer', 'certification'].includes(String(item.sourceType)) ||
      ['productName', 'brand'].some(key => typeof item[key] !== 'string' || !item[key].trim() || item[key].length > 300)))) {
    throw new Error('AI returned invalid web claims.');
  }
  if (value.webCompositions !== undefined && (!Array.isArray(value.webCompositions) || value.webCompositions.length > 3 ||
    value.webCompositions.some(item => !object(item) || Object.keys(item).some(key => !['url', 'text', 'ingredients', 'complete', 'sourceType', 'productName', 'brand'].includes(key)) ||
      typeof item.url !== 'string' || item.url.length > 2000 || !safeSourceUrl(item.url) ||
      typeof item.text !== 'string' || !item.text.trim() || item.text.length > 20_000 || typeof item.complete !== 'boolean' ||
      item.ingredients !== undefined && !validIngredientList(item.ingredients) ||
      !['manufacturer', 'retailer'].includes(String(item.sourceType)) ||
      ['productName', 'brand'].some(key => typeof item[key] !== 'string' || !item[key].trim() || item[key].length > 300)))) {
    throw new Error('AI returned invalid researched composition.');
  }
  if (value.research !== undefined && (!object(value.research) ||
    Object.keys(value.research).some(key => !['searched', 'sources'].includes(key)) || typeof value.research.searched !== 'boolean' ||
    !Array.isArray(value.research.sources) || value.research.sources.length > 50 ||
    value.research.sources.some(item => !object(item) || Object.keys(item).some(key => !['url', 'title'].includes(key)) ||
      typeof item.url !== 'string' || item.url.length > 2000 || !safeSourceUrl(item.url) || typeof item.title !== 'string' || item.title.length > 300))) {
    throw new Error('Provider returned invalid web search metadata.');
  }
  const { contact: rawContact, companyAssessment: rawCompanyAssessment, ...assessment } = value;
  const contact = parseManufacturerContact(rawContact);
  const companyAssessment = parseCompanyAssessment(rawCompanyAssessment);
  return { ...assessment, ...(contact ? { contact } : {}), ...(companyAssessment ? { companyAssessment } : {}) } as unknown as AIExtraction;
}
export function parseAIExtraction(text: string): AIExtraction {
  if (text.length > 100_000) throw new Error('AI extraction is too large.');
  const trimmed = text.trim().replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
  const parsed: unknown = JSON.parse(trimmed);
  return validateAIExtraction(parsed);
}

/** Search provenance comes from the Responses envelope, never from the model's JSON text. */
function parseResponsesExtraction(body: unknown): AIExtraction {
  if (!object(body) || body.status !== 'completed' || !Array.isArray(body.output)) throw new Error('AI response was incomplete; no verdict was accepted.');
  const sources = new Map<string, { url: string; title: string }>();
  let searched = false;
  const text: string[] = [];
  const addSource = (source: unknown) => {
    if (!object(source) || typeof source.url !== 'string' || source.url.length > 2000 || !safeSourceUrl(source.url)) return;
    if (sources.size >= 50 && !sources.has(source.url)) return;
    const previous = sources.get(source.url);
    sources.set(source.url, { url: source.url, title: typeof source.title === 'string' ? source.title.slice(0, 300) : previous?.title ?? '' });
  };
  for (const item of body.output) {
    if (!object(item)) continue;
    if (item.type === 'web_search_call' && item.status === 'completed') {
      searched = true;
      if (object(item.action) && Array.isArray(item.action.sources)) item.action.sources.forEach(addSource);
      if (object(item.action) && typeof item.action.url === 'string') addSource({ url: item.action.url });
    }
    if (item.type !== 'message' || item.role !== 'assistant' || !Array.isArray(item.content)) continue;
    for (const part of item.content) {
      if (!object(part)) continue;
      if (part.type === 'refusal') throw new Error('AI response was refused; no verdict was accepted.');
      if (part.type === 'output_text' && typeof part.text === 'string') {
        text.push(part.text);
        if (Array.isArray(part.annotations)) {
          for (const annotation of part.annotations) if (object(annotation) && annotation.type === 'url_citation') addSource(annotation);
        }
      }
    }
  }
  if (!text.length) throw new Error('AI provider returned no completion.');
  const extraction = parseAIExtraction(text.join('\n'));
  return { ...extraction, research: { searched, sources: searched ? [...sources.values()] : [] } };
}
function researchAssessment(extracted: AIExtraction, input: CheckInput) {
  const visible: CheckInput = { text: extracted.text, complete: extracted.complete, category: input.category && input.category !== 'other' ? input.category : extracted.category,
    name: input.name || extracted.name, brand: input.brand || extracted.brand, locale: input.locale, images: input.images };
  return applyWebEvidence(applyAIEvidence(analyzeText(visible, undefined, extracted.ingredients), visible, extracted, extracted.complete), visible, extracted);
}
function needsResearch(extracted: AIExtraction, input: CheckInput): boolean {
  return Boolean(extracted.name?.trim() && extracted.brand?.trim() && researchAssessment(extracted, input).outcome === 'uncertain');
}
function publicResearchQuestions(extracted: AIExtraction, input: CheckInput): string[] {
  return researchAssessment(extracted, input).findings.filter(finding => finding.evidenceId?.startsWith('web-composition-') &&
    ['unknown', 'ambiguous'].includes(finding.status)).map(finding => finding.term).slice(0, 20);
}
function mergeResearch(original: AIExtraction, researched: AIExtraction): AIExtraction {
  const key = (value: string | undefined) => value?.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
  if (!researched.research?.searched || key(original.name) !== key(researched.name) || key(original.brand) !== key(researched.brand)) return original;
  const unique = <T>(values: T[]): T[] => [...new Map(values.map(value => [JSON.stringify(value), value])).values()];
  const assessments = unique([...(original.ingredientAssessments ?? []), ...(researched.ingredientAssessments ?? [])]);
  const webClaims = unique([...(original.webClaims ?? []), ...(researched.webClaims ?? [])]);
  const compositions = new Map<string, NonNullable<AIExtraction['webCompositions']>[number]>();
  for (const item of [...(original.webCompositions ?? []), ...(researched.webCompositions ?? [])]) {
    const sourceKey = JSON.stringify([item.url, key(item.text), item.complete, item.sourceType, key(item.productName), key(item.brand)]);
    const previous = compositions.get(sourceKey);
    compositions.set(sourceKey, { ...item, ingredients: parseSourceIngredients(item.text, item.ingredients) ? item.ingredients : previous?.ingredients ?? item.ingredients });
  }
  const webCompositions = [...compositions.values()];
  const consulted = new Map([...(original.research?.sources ?? []), ...researched.research.sources].map(source => [source.url, source]));
  const citedUrls = new Set<string>([
    ...webCompositions.map(item => item.url),
    ...webClaims.map(item => item.url),
    ...[original.contact, researched.contact].flatMap(contact => contact ? [contact.sourceUrl, ...(contact.url ? [contact.url] : [])] : []),
    ...[original.companyAssessment, researched.companyAssessment].flatMap(company => company ? [
      ...company.sources.map(source => source.url), ...(company.ownershipSourceUrl ? [company.ownershipSourceUrl] : []),
    ] : []),
  ]);
  const sources = [...consulted.values()].sort((a, b) => Number(citedUrls.has(b.url)) - Number(citedUrls.has(a.url))).slice(0, 50);
  // Preserve all original evidence and later contradictions, or keep the original intact when bounds are exceeded.
  if (assessments.length > 100 || webClaims.length > 5 || webCompositions.length > 3) return original;
  const companyAssessment = sourcedCompanyAssessment({ ...researched, research: { searched: true, sources } });
  return { ...original, webClaims, webCompositions, ingredientAssessments: assessments,
    ...(researched.contact ? { contact: researched.contact } : {}),
    ...(companyAssessment ? { companyAssessment } : {}), research: { searched: true, sources } };
}
export function validateProviderConfig(config: ProviderConfig): URL {
  const base = new URL(config.baseUrl);
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname);
  if (base.username || base.password || base.search || base.hash || !(base.protocol === 'https:' || base.protocol === 'http:' && loopback)) {
    throw new Error('Use an HTTPS endpoint, or HTTP on this device’s localhost. Credentials belong in the token field.');
  }
  if (!config.model.trim() || config.model.length > 200) throw new Error('Choose a model.');
  if (config.token && /[\r\n]/.test(config.token)) throw new Error('Invalid API token.');
  return base;
}
export function createOpenAIProvider(config: ProviderConfig, fetcher: typeof fetch = globalThis.fetch, catalogueFetcher?: typeof fetch): ProviderAdapter {
  const base = validateProviderConfig(config);
  const supportsWebSearch = base.origin === 'https://api.openai.com' && base.pathname.replace(/\/$/, '') === '/v1';
  const endpoint = new URL(`${base.pathname.replace(/\/$/, '')}/${supportsWebSearch ? 'responses' : 'chat/completions'}`, base.origin).href;
  return {
    supportsWebSearch,
    async extract(input, signal, countryContext): Promise<AIExtraction> {
      const images = input.images ?? [];
      if (images.length > 3) throw new Error('Use at most three product photos per check.');
      if (images.length && !(config.supportsVision ?? acceptsImages(config.model))) throw new Error('Choose a vision-capable model for photo checks.');
      for (const image of images) {
        if (!/^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+=*$/.test(image) || image.length > 4_000_000) {
          throw new Error('Use a locally sanitized JPEG, PNG or WebP photo smaller than 3 MB.');
        }
      }
      if ((input.text?.length ?? 0) > 30_000) throw new Error('Selected text exceeds 30,000 characters.');
      const content: ({ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } })[] = [
        { type: 'text', text: JSON.stringify({ text: input.text ?? '', name: input.name, brand: input.brand, barcode: input.barcode && normalizeBarcode(input.barcode), sourceUrl: input.sourceUrl, category: input.category, complete: input.complete, locale: input.locale ?? 'en', market: input.market ?? 'DE' }) },
        ...images.map(url => ({ type: 'image_url' as const, image_url: { url } })),
      ];
      const requestBody = supportsWebSearch ? {
        model: config.model, stream: false, store: false, instructions: EXTRACTION_PROMPT, max_output_tokens: 6000,
        tools: [{ type: 'web_search' }], max_tool_calls: 3, include: ['web_search_call.action.sources'],
        input: [{ role: 'user', content: content.map(part => part.type === 'text'
          ? { type: 'input_text', text: part.text } : { type: 'input_image', image_url: part.image_url.url }) }],
      } : { model: config.model, stream: false, max_tokens: 6000,
        messages: [{ role: 'system', content: EXTRACTION_PROMPT }, { role: 'user', content }] };
      const deadlineSignal = AbortSignal.timeout(130_000);
      const requestSignal = signal ? AbortSignal.any([signal, deadlineSignal]) : deadlineSignal;
      async function send(body: unknown): Promise<unknown> {
        const response = await fetcher(endpoint, {
          method: 'POST', credentials: 'omit', redirect: 'error', signal: requestSignal,
          headers: { 'Content-Type': 'application/json', ...(config.token ? { Authorization: `Bearer ${config.token}` } : {}) },
          body: JSON.stringify(body),
        });
        if (!response.ok) throw new Error(`AI provider returned HTTP ${response.status}. Check your connection, model, and allowance.`);
        return JSON.parse(await readBoundedText(response, 100_000));
      }
      const body = await send(requestBody);
      if (supportsWebSearch) {
        const extracted = parseResponsesExtraction(body);
        const researchInput = { ...input, market: selectProductCountry(
          { ...input, market: countryContext?.fallbackMarket ?? input.market }, extracted.packaging?.country, countryContext?.markets,
        ).market };
        let catalogue: Awaited<ReturnType<typeof lookupMatspar>>;
        if (input.images?.length && needsResearch(extracted, input)) {
          try {
            catalogue = await lookupMatspar(extracted, researchInput, catalogueFetcher ?? fetcher, requestSignal);
          } catch (error) {
            if (requestSignal.aborted) throw error;
          }
        }
        if (!needsResearch(extracted, input)) return extracted;
        try {
          const researched = parseResponsesExtraction(await send({ ...requestBody, tool_choice: 'required',
            instructions: `${EXTRACTION_PROMPT}\n${promptData.researchPrompt}${catalogue ? '\n\nA verified Matspar product record has already been fetched and exact-matched. Use its ingredients only as parsing input. Do not perform another product lookup or treat its ingredients as photo transcription or a vegan claim. Keep the same canonical name and brand, top-level text empty and complete false. Return its full composition in webCompositions with every source-verbatim ingredient parsed, and ingredientAssessments for every parsed term. Continue web research only for unresolved origins or a product-specific declaration.' : ''}`,
            text: { format: { type: 'json_schema', name: 'product_research', strict: false, schema: {
              type: 'object', properties: { name: { type: 'string', enum: [extracted.name] }, brand: { type: 'string', enum: [extracted.brand] } },
              required: ['text', 'complete', 'category', 'name', 'brand'],
            } } },
            input: [{ role: 'user', content: [{ type: 'input_text', text: JSON.stringify({ name: extracted.name, brand: extracted.brand,
              packaging: extracted.packaging, barcode: normalizeBarcode(input.barcode ?? '') ?? normalizeBarcode(extracted.barcode ?? ''),
              category: extracted.category, market: researchInput.market, locale: input.locale ?? 'en', unresolvedIngredients: publicResearchQuestions(extracted, researchInput),
              ...(catalogue ? { catalogueComposition: catalogue } : {}) }) }] }],
          }));
          const merged = mergeResearch(extracted, catalogue && matchesMatsparIdentity(researched, extracted) ? { ...researched, name: extracted.name, brand: extracted.brand } : researched);
          return catalogue ? retainMatsparComposition(merged, catalogue) : merged;
        } catch (error) {
          if (signal?.aborted) throw error;
          return catalogue ? retainMatsparComposition(extracted, catalogue) : extracted;
        }
      }
      if (!object(body) || !Array.isArray(body.choices) || !object(body.choices[0])) throw new Error('AI provider returned no completion.');
      const choice = body.choices[0];
      if (choice.finish_reason !== 'stop' || !object(choice.message) || typeof choice.message.content !== 'string' || choice.message.refusal) {
        throw new Error('AI response was incomplete or refused; no verdict was accepted.');
      }
      return parseAIExtraction(choice.message.content);
    },
  };
}
