import type { CheckInput, MarketSource } from './types';
import countries from '../../../contracts/product-countries.json';
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
  if (!markets.length) return locale === 'de'
    ? 'Dieser Datensatz bestätigt das Produktland nicht. Vergleiche die Rezeptur mit deiner Packung.'
    : 'This record does not confirm the product country. Compare its composition with your package.';
  if (!markets.some(tag => countryCode(tag) === market)) return locale === 'de'
    ? `Dieser Datensatz nennt andere Märkte als ${market}. Vergleiche die Rezeptur mit deiner Packung.`
    : `This record lists other markets than ${market}. Compare its composition with your package.`;
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
