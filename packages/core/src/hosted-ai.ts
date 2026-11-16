import configuration from '../../../data/hosted-ai.json';
import type { ProviderAdapter } from './types';
import { readBoundedText } from './http';
import { AIFailure, httpFailure } from './ai-error';
import { validateAIExtraction } from './provider';
import { countryCode } from './market';

export const HOSTED_AI = configuration;
export function createHostedAIProvider(token: string, fetcher: typeof fetch = globalThis.fetch): ProviderAdapter {
  return {
    supportsWebSearch: true, hosted: true,
    async extract(input, signal, countryContext) {
      const {autoMarket: _autoMarket, ...product} = input;
      const context = input.autoMarket ? {
        fallbackMarket: countryCode(countryContext?.fallbackMarket ?? input.market ?? 'DE') ?? 'DE',
        markets: [...new Set((countryContext?.markets ?? []).map(value => countryCode(value) ?? 'unknown'))],
      } : undefined;
      if (!/^[a-f0-9]{64}$/.test(token)) throw new AIFailure('authentication', 'Connect to Vegsnap AI in settings first.');
      const response = await fetcher(`${HOSTED_AI.baseUrl}/api/check`, {
        method: 'POST', credentials: 'omit', redirect: 'error',
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(135_000)]) : AbortSignal.timeout(135_000),
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ ...product, ...(context ? { countryContext: context } : {}), ...(countryContext?.database ? { databaseComposition: countryContext.database } : {}) }),
      });
      if (!response.ok) throw await httpFailure(response, 'Vegsnap AI');
      return validateAIExtraction(JSON.parse(await readBoundedText(response, 1_048_576)), { allowResearch: true });
    },
  };
}
