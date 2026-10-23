import type { CheckInput, MarketSource } from './types';
import countries from '../../../contracts/product-countries.json';
import { resultMessages } from './i18n';
import { appLocale } from './locale';
// Shared with the desktop companion so local research uses identical country clues.
const countryCodes = new Set<string>(countries.codes);
const aliases: Readonly<Record<string, string>> = countries.aliases;
export function countryCode(value: string): string | undefined {
  const code = value.trim().toUpperCase();
  if (countryCodes.has(code)) return code;
  const name = value.normalize('NFKC').trim().toLowerCase().replace(/^en:/, '').replace(/[\s-]/g, '');
  return Object.hasOwn(aliases, name) ? aliases[name] : undefined;
}
/** Regional indicator pair, rendered as a flag where the platform font supports it. */
export function countryFlag(code: string): string {
  return String.fromCodePoint(...[...code.toUpperCase()].map(letter => 0x1f1a5 + letter.charCodeAt(0)));
}
/** Every selectable product country with its localized name, sorted for display. */
export function countryOptions(locale?: string): { code: string; name: string; flag: string }[] {
  const language = appLocale(locale);
  const names = new Intl.DisplayNames([language], { type: 'region' });
  const collator = new Intl.Collator(language);
  return countries.codes.map(code => ({ code, name: names.of(code) ?? code, flag: countryFlag(code) }))
    .sort((a, b) => collator.compare(a.name, b.name));
}
/** Pack regions are Open Food Facts country names ("united-kingdom"), "eu" or code pairs such as the bundled "de-eu"; other regions keep their own text. */
export function packRegionName(region: string, locale?: string): string {
  const names = new Intl.DisplayNames([appLocale(locale)], { type: 'region' });
  const code = (value: string) => value.toUpperCase() === 'EU' ? 'EU' : countryCode(value);
  const whole = code(region);
  if (whole) return names.of(whole) ?? region;
  const parts = region.split('-').map(part => part.length === 2 ? code(part) : undefined);
  return parts.length > 1 && parts.every(Boolean) ? parts.map(part => names.of(part!)).join(' + ') : region;
}
export function singleProductCountry(markets: readonly string[]): string | undefined {
  const codes = markets.map(countryCode);
  if (!codes.length || codes.some(code => !code)) return;
  return new Set(codes).size === 1 ? codes[0] : undefined;
}
/** Composition stays attributed to its record, even when the displayed country changes. */
export function databaseCountryWarning(market: string, markets: readonly string[], locale?: string): string | undefined {
  const t = resultMessages[appLocale(locale)];
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
