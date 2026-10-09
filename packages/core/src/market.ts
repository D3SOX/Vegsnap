import type { CheckInput, MarketSource } from './types';
// ISO 3166-1 alpha-2 codes; used to reject non-country AI guesses.
const countryCodes = new Set('AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW'.split(' '));

/** Canonical Open Facts tags that differ from system names, plus common markets.
 * Source: https://github.com/openfoodfacts/openfoodfacts-server/blob/main/taxonomies/countries.txt
 */
export const marketCountries: Readonly<Record<string, string>> = {
  DE: 'germany', AT: 'austria', CH: 'switzerland', SE: 'sweden', FI: 'finland', DK: 'denmark', NO: 'norway',
  FR: 'france', NL: 'netherlands', BE: 'belgium', ES: 'spain', IT: 'italy', PL: 'poland', IE: 'ireland', PT: 'portugal',
  GB: 'united-kingdom', US: 'united-states', CA: 'canada', AU: 'australia',
  AQ: 'antarctic', AG: 'antigua-and-barbuda', BA: 'bosnia-and-herzegovina',
  CC: 'cocos-keeling-islands', CW: 'curacao', CZ: 'czech-republic',
  CI: 'cote-d-ivoire', CD: 'democratic-republic-of-the-congo', FM: 'federated-states-of-micronesia',
  TF: 'french-southern-and-antarctic-lands', HM: 'heard-island-and-mcdonald-islands', HK: 'hong-kong',
  MO: 'macau', MM: 'myanmar', PN: 'pitcairn',
  CG: 'republic-of-the-congo', RE: 'reunion', SH: 'saint-helena',
  KN: 'saint-kitts-and-nevis', LC: 'saint-lucia', MF: 'saint-martin',
  PM: 'saint-pierre-and-miquelon', VC: 'saint-vincent-and-the-grenadines', BL: 'saint-barthelemy',
  ST: 'sao-tome-and-principe', GS: 'south-georgia-and-the-south-sandwich-islands', PS: 'state-of-palestine',
  SJ: 'svalbard-and-jan-mayen', SZ: 'swaziland', BS: 'the-bahamas',
  TT: 'trinidad-and-tobago', TR: 'turkey', TC: 'turks-and-caicos-islands',
  UM: 'united-states-minor-outlying-islands', VI: 'virgin-islands-of-the-united-states', WF: 'wallis-and-futuna',
  AX: 'aland-islands',
};
const names = new Intl.DisplayNames(['en'], { type: 'region' });
const aliases: Record<string, string> = Object.fromEntries([...countryCodes].map(code => [(names.of(code) ?? code).toLowerCase().replace(/[\s-]/g, ''), code]));
Object.assign(aliases, Object.fromEntries(Object.entries(marketCountries).map(([code, name]) => [name.replace(/-/g, ''), code])));
Object.assign(aliases, { deutschland: 'DE', sverige: 'SE', suomi: 'FI', uk: 'GB', usa: 'US' });
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
