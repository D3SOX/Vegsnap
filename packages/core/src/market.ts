import type { CheckInput, MarketSource } from './types';
import countries from '../../../contracts/product-countries.json';
import { resultMessages } from './i18n';
// Shared with the desktop companion so local research uses identical country clues.
const countryCodes = new Set<string>(countries.codes);
const aliases: Readonly<Record<string, string>> = countries.aliases;
export function countryCode(value: string): string | undefined {
  const code = value.trim().toUpperCase();
  if (countryCodes.has(code)) return code;
  const name = value.normalize('NFKC').trim().toLowerCase().replace(/^en:/, '').replace(/[\s-]/g, '');
  return Object.hasOwn(aliases, name) ? aliases[name] : undefined;
}
export function singleProductCountry(markets: readonly string[]): string | undefined {
  const codes = markets.map(countryCode);
  if (!codes.length || codes.some(code => !code)) return;
  return new Set(codes).size === 1 ? codes[0] : undefined;
}
/** Composition stays attributed to its record, even when the displayed country changes. */
export function databaseCountryWarning(market: string, markets: readonly string[], locale?: string): string | undefined {
  const t = resultMessages[locale === 'de' ? 'de' : 'en'];
  if (!markets.length) return t.countryUnknownWarning;
  if (!markets.some(tag => countryCode(tag) === market)) return t.countryMismatchWarning.replace('{market}', market);
}
/** Packaging can disambiguate a multi-country record; conflicting or unknown clues use the fallback. */
export function selectProductCountry(
  input: Pick<CheckInput, 'market' | 'autoMarket'>, packagingCountry?: string, markets: readonly string[] = [],
): { market: string; marketSource: MarketSource } {
  const fallback = countryCode(input.market ?? 'DE') ?? 'DE';
  if (!input.autoMarket) return { market: fallback, marketSource: 'manual' };
  const packaging = packagingCountry ? countryCode(packagingCountry) : undefined;
  const codes = markets.map(countryCode);
  const unknownClue = Boolean(packagingCountry && !packaging) || codes.some(code => !code);
  const conflictingClues = packaging && codes.length && !codes.includes(packaging);
  if (unknownClue || conflictingClues) return { market: fallback, marketSource: 'fallback' };
  if (packaging) return { market: packaging, marketSource: 'packaging' };
  const database = singleProductCountry(markets);
  return database ? { market: database, marketSource: 'database' } : { market: fallback, marketSource: 'fallback' };
}
