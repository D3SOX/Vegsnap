import * as core from '../../packages/core/src/index';
import { mergeResults } from '../../packages/core/src/merge-results';
import { identifiedProduct } from './identified-product';
import bundled from '../../data/offline/bundle.json';

// Native UI/network/storage live in Swift. Only the audited decision engine is shared.
const host = globalThis as typeof globalThis & {
  nativeComplete(id: string, value: string, error: string): void;
  nativeProgress(id: string, stage: string): void;
};
let snapshots = [core.validateOfflineSnapshot(bundled)];
let index = new core.OfflineProductIndex(snapshots);
const operations = new Map<string, AbortController>();
export function call(operation: string, json: string): string {
  const args = JSON.parse(json);
  switch (operation) {
    case 'analyze': return JSON.stringify(core.attachCompanyConcerns(core.analyzeText(args), args.locale));
    case 'merge': return JSON.stringify(mergeResults(args.original, args.additional));
    case 'barcode': return JSON.stringify(core.normalizeBarcode(args) ?? null);
    case 'message': return JSON.stringify(core.manufacturerMessage(args.result, args.locale) ?? null);
    case 'community': return JSON.stringify(core.communityLinks(args.result, args.locale) ?? null);
    case 'acceptsImages': return JSON.stringify(core.acceptsImages(args.model, args.metadata));
    case 'provider': core.validateProviderConfig(args); return 'true';
    case 'snapshot': return JSON.stringify(core.validateOfflineSnapshot(args));
    case 'snapshots': snapshots = [core.validateOfflineSnapshot(bundled), ...args.map(core.validateOfflineSnapshot)]; index = new core.OfflineProductIndex(snapshots); return 'true';
    case 'offlineSearch': return JSON.stringify(index.search(args.source, args.query, args.offset, args.market));
    case 'packs': return JSON.stringify(snapshots.map(s => ({ region: s.region, generatedAt: s.generatedAt, count: s.products.length })));
    case 'mergeOCR': {
      const result = args.result as core.CheckResult;
      if (result.usedAI || result.outcome !== 'uncertain') return JSON.stringify(result);
      const text = (args.text as string).match(/(?:^|\n)[^\S\r\n]*(?:ingredients|ingredienser|zutaten|materials|material|zusammensetzung|composition)\s*:[\s\S]*/i)?.[0];
      if (text) {
        const ocr = core.analyzeText({ ...args.input, text: text.slice(0, 30000), complete: false });
        ocr.evidence.forEach(e => { e.kind = 'ocr'; e.title = args.input.locale === 'de' ? 'Texterkennung auf dem Gerät — am Etikett prüfen' : 'On-device text recognition — verify against the label'; });
        return JSON.stringify(core.attachCompanyConcerns(mergeResults(result, ocr), args.input.locale));
      }
      return JSON.stringify(result);
    }
    default: throw new Error('Unknown engine operation');
  }
}
export function cancel(id: string) { operations.get(id)?.abort(); }
export function check(id: string, json: string) {
  const args = JSON.parse(json);
  const controller = new AbortController(); operations.set(id, controller);
  void (async () => {
    try {
      let extraction: core.AIExtraction | undefined;
      const adapter: core.ProviderAdapter | undefined = args.hostedToken ? core.createHostedAIProvider(args.hostedToken) : args.provider ? {
        supportsWebSearch: args.provider.baseUrl.replace(/\/$/, '') === 'https://api.openai.com/v1',
        extract: (input, signal) => core.createOpenAIProvider(args.provider, args.chatGPT ? (globalThis as typeof globalThis & { chatGPTFetch: typeof fetch }).chatGPTFetch : undefined, globalThis.fetch).extract(input, signal),
      } : undefined;
      const provider: core.ProviderAdapter | undefined = adapter && { ...adapter, extract: async (input, signal) => {
        extraction = core.validateAIExtraction(await adapter.extract(input, signal), { allowResearch: true });
        return extraction;
      } };
      const options: core.CheckOptions = { mode: 'explicit', offline: args.offline, provider, offlineProducts: index, signal: controller.signal, onProgress: stage => { if (operations.get(id) === controller) host.nativeProgress(id, stage); } };
      let result = await core.checkProduct(args.input, options);
      // Barcode-only checks can research the exact database identity. Keep database
      // composition in its original evidence, never reclassify it as supplied text.
      if (result.outcome === 'uncertain' && provider && !args.offline && !args.input.text?.trim() && !args.input.images?.length && !args.input.name?.trim() && result.identity.name) {
        result = await core.checkProduct({ ...args.input, name: result.identity.name.slice(0, 300), brand: result.identity.brand?.slice(0, 300) }, options);
      }
      if (extraction && !args.offline && result.outcome === 'uncertain' && result.aiStatus !== 'failed') {
        try {
          const database = await identifiedProduct(extraction, args.input, controller.signal);
          if (database) result = core.attachCompanyConcerns({ ...mergeResults(result, database),
            manufacturerContact: result.manufacturerContact, companyAssessment: result.companyAssessment }, args.input.locale, result.identity.brand);
        } catch (error) { if (controller.signal.aborted) throw error; }
      }
      if (!args.aiEnabled && result.aiStatus === 'unconfigured') result.aiStatus = 'disabled';
      if (operations.get(id) === controller) host.nativeComplete(id, JSON.stringify(core.localizeResult(result, args.input.locale)), '');
    } catch (error) { if (operations.get(id) === controller) host.nativeComplete(id, '', error instanceof Error ? error.message : 'Check failed'); }
    finally { if (operations.get(id) === controller) operations.delete(id); }
  })();
}

Object.assign(globalThis, { VegsnapCore: { call, check, cancel } });
