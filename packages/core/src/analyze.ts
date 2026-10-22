import { analysisMessages, resultMessages } from './i18n';
import rulesData from '../../../data/rules.json';
import { normalizeBarcode } from './database';
import type { CheckInput, CheckResult, Evidence, Finding, Locale } from './types';

const additiveRoles = `(?:säuerungsmittel|säureregulator(?:en)?|farbstoff(?:e)?|emulgator(?:en)?|verdickungsmittel|stabilisator(?:en)?|konservierungsstoff(?:e)?|antioxidationsmittel|backtriebmittel|geliermittel|überzugsmittel|süßungsmittel|süssungsmittel|acidity regulators?|acidifiers?|colou?r(?:ing)?s?|emulsifiers?|thickeners?|stabilisers?|stabilizers?|preservatives?|antioxidants?|raising agents?|gelling agents?|glazing agents?|sweeteners?|surhetsreglerande medel|syror|färgämnen?|förtjockningsmedel|stabiliseringsmedel|emulgeringsmedel|konserveringsmedel|antioxidationsmedel|bakpulver|jäsmedel|sötningsmedel|geleringsmedel|gelatineringsmedel|humectants?|firming agents?|flavou?r enhancers?|bulking agents?|anti-?caking agents?|flour treatment agents?|emulsifying salts?|acidity correctors?|food acids?|acids?(?= *:)|mineral salts?|vegetable gums?|leavening(?: agents?)?|feuchthaltemittel|geschmacksverstärker|trennmittel|mehlbehandlungsmittel|festigungsmittel|füllstoffe?|schmelzsalze?|syra|fuktighetsbevarande medel|smakförstärkare|klumpförebyggande medel|ytbehandlingsmedel|mjölbehandlingsmedel|fyllnadsmedel|acidifiants?|correcteurs? d['’]acidité|[ée]mulsifiants?|[ée]paississants?|stabilisants?|gélifiants?|conservateurs?|antioxydants?|colorants?|édulcorants?|affermissants?|exhausteurs? de go[uû]t|agents? de traitement de la farine|agents? d['’]enrobage|agents? de charge|poudres? à lever|agents? levants?|anti-?agglomérants?|séquestrants?|sels? de fonte|acidulantes?|correctores? de (?:la )?acidez|reguladores? de (?:la )?acidez|emulgentes?|emulsionantes?|espesantes?|estabilizantes?|estabilizadores?|gelificantes?|conservadores?|conservantes?|antioxidantes?|colorantes?|edulcorantes?|potenciadores? del sabor|gasificantes?|impulsores?|agentes? de recubrimiento|humectantes?|antiaglomerantes?|sales fundentes|acidificant[ei]|correttor[ei] di acidità|regolator[ei] di acidità|emulsionant[ei]|addensant[ei]|stabilizzant[ei]|gelificant[ei]|conservant[ei]|antiossidant[ei]|colorant[ei]|edulcorant[ei]|esaltator[ei] di sapidità|agent[ei] lievitant[ei]|agent[ei] di rivestimento|umidificant[ei]|antiagglomerant[ei]|agent[ei] di carica|sali di fusione|zuurteregelaars?|voedingszu(?:ur|ren)|verdikkingsmiddel(?:en)?|geleermiddel(?:en)?|conserveermiddel(?:en)?|antioxidanten|kleurstof(?:fen)?|zoetstof(?:fen)?|smaakversterkers?|rijsmiddel(?:en)?|glansmiddel(?:en)?|bevochtigingsmiddel(?:en)?|antiklontermiddel(?:en)?|meelverbeteraars?|verstevigingsmiddel(?:en)?|emulgatorer|fortykningsmid(?:del|ler)|konserveringsmid(?:del|ler)|surhetsregulerende mid(?:del|ler)|surhedsregulerende mid(?:del|ler)|antioksidant(?:er)?|antioxidanter|fargestoff(?:er)?|farvestof(?:fer)?|stabilisatorer|søtstoff(?:er)?|sødestof(?:fer)?|hevemid(?:del|ler)|hævemid(?:del|ler)|smaksforsterker|smagsforstærker|fuktighetsbevarende middel|fugtighedsbevarende middel|melbehandlingsmiddel|overflatebehandlingsmiddel|overfladebehandlingsmiddel|geleringsmiddel|(?:emulgointi|happamuudensäätö|säilöntä|sakeuttamis|stabilointi|väri|makeutus|kohotus|hapettumisenesto|kostutus|paakkuuntumisenesto|pintakäsittely|hyytelöimis)aine(?:et)?|arominvahven(?:ne|teet)|jauhonparanne|farge|farve|konsistensmid(?:del|ler)|fuktighetsbevarer|antiklump(?:e|nings)mid(?:del|ler)|surheitsregulerande mid(?:del|lar)|surhetsregulator(?:er)?|smeltesalt(?:er)?|melbehandlingsmidler|syrer?(?= *:)|nostatusaine(?:et)?|värit?|kosteudensäilyttäjä|hap(?:po|ot)(?= *:))`;
const additivePrefix = new RegExp(String.raw`^\s*${additiveRoles}(?:\s*:\s*|\s+)(?=\S)`, 'iu');
// Australian and New Zealand labels give additives as bare INS numbers after their role ("emulsifier (471)", "mineral salts (452, 450)", "food acid: 330"); elsewhere a bare number is a quantity or a nutrition value.
const insAfterRole = new RegExp(String.raw`(?<![\p{L}\p{N}])${additiveRoles}\s*(?:\([^()]*\)|:[^,;()\n]*)`, 'giu');
const additiveGroup = new RegExp(String.raw`(?<![\p{L}\p{N}])${additiveRoles}\s*:?\s*(?=\(\s*[\p{L}\p{N}])`, 'giu');
const materialRoles = `(?:upper(?: material)?|lining|inner material|insole|outsole|sole|oberstoff|obermaterial|außenmaterial|aussenmaterial|innenmaterial|innensohle|decksohle|laufsohle|futter|sohle|ovandel|foder|innersula|yttersula)`;
const materialPrefix = new RegExp(String.raw`^\s*${materialRoles}\s*:\s*`, 'iu');
const materialSection = new RegExp(String.raw`(?:^|\n)[^\S\r\n]*${materialRoles}\s*:`, 'iu');

// A list split before its last item leaves the conjunction on it ("sugar, and salt", "and/or sunflower oil").
const leadingConjunction = /^(?:and\/or|und\/oder|and|und|och|og|ja|et|ou|y|ed|en|or|oder|eller) (?=\S)/u;
export function normalizeTerm(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/’/g, "'").replace(/[_*"]/g, '').replace(/(?<=\p{L}{4})\d{1,2}$/u, '').replace(/\d+(?:[.,]\d+)?\s*%/g, '')
    .replace(/\b(?:organic|bio)\b/g, '').replace(materialPrefix, '')
    .replace(additivePrefix, '').replace(/^\s*(?:gemüse|vegetables|grönsaker)\s*[-–:]\s*(?=\S)/iu, '')
    .replace(/\s+/g, ' ').trim().replace(/[.!]+$/, '').trim().replace(leadingConjunction, '');
}

/** Discard typography notes only, retaining genuine allergen and subingredient text. */
export function compositionTerms(text: string, materialContext = false): string[] {
  let value = text.replace(/&(?:quot|#34);/g, '"').replace(/&(?:apos|#39);/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').split('\n').filter(line => !/^\s*[*†]\s*(?:Allergioita tai intoleransseja aiheuttavat aineet korostettu|Ämnen som kan orsaka allergier eller intoleranser (?:är|har) markerade)\.?\s*$/i.test(line)).join('\n');
  const groups = [...value.matchAll(/\b(?:vitamins?|vitamine[ns]?|vitaminer|vitamiinit|vitaminas|vitamini)\s*\(/gi)];
  for (const group of groups.reverse()) {
    const start = group.index! + group[0].length;
    let end = start, depth = 1;
    while (end < value.length && depth) { if (value[end] === '(') depth++; if (value[end] === ')') depth--; end++; }
    if (depth) continue;
    const content = value.slice(start, end - 1);
    const expanded = content.replace(/\b(?:[ADEK]|B\d{1,2}|D[23])\b/gi, (term: string, offset: number) => /vitamin\s+$/i.test(content.slice(0, offset)) ? term : `vitamin ${term}`);
    value = value.slice(0, group.index!) + '(' + expanded + ')' + value.slice(end);
  }
  if (materialContext || materialSection.test(text)) value = value.replace(/\//g, ',');
  return value.replace(/\d+(?:[.,]\d+)?\s*%/g, '')
    .replace(/\(\s*(?:teilentölt|entölt|partially defatted|defatted|partially deoiled|deoiled|delvis avfettat)\s*\)/gi, '')
    .replace(insAfterRole, role => role.replace(/(?<![\p{L}\p{N}])(?<![eE][\s-])(\d{3,4}[a-h]?)(?!\p{N})/gu, 'e$1'))
    .replace(additiveGroup, '')
    .split(/[,;\n()[\]{}]/).map(normalizeTerm).filter(Boolean);
}

function containsWord(text: string, word: string): boolean {
  let start = text.indexOf(word);
  while (start >= 0) {
    if (!/[\p{L}\p{N}]/u.test(text[start - 1] ?? '') && !/[\p{L}\p{N}]/u.test(text[start + word.length] ?? '')) return true;
    start = text.indexOf(word, start + 1);
  }
  return false;
}

/** Preserve chemical punctuation and verify every AI term against intentional source composition. */
export function parseSourceIngredients(text: string, value: unknown): string[] | undefined {
  if (!Array.isArray(value) || !value.length || value.length > 100 || value.some(term => typeof term !== 'string' || !term.trim() || term.length > 300)) return undefined;
  const source = text.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
  const precautionMatch = precaution.exec(source);
  const intentional = precautionMatch ? source.slice(0, precautionMatch.index) : source;
  const terms = (value as string[]).map(term => term.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim());
  return terms.every(term => containsWord(intentional, term)) ? [...new Set(terms.map(normalizeTerm))] : undefined;
}

/** Alcoholic/fermented beverage processing needs evidence; ordinary plant drinks do not inherit that veto. */
export function needsProcessingEvidence(input: CheckInput): boolean {
  return input.category === 'drink' && /(?:^|[^\p{L}\p{N}])(?:wine|wein|vin|vino|wijn|viini|beer|bier|bière|biere|birra|cerveza|olut|øl|ale|lager|cider|cidre|sidra|sidro|champagne|sekt|prosecco|alcohol|alkohol|ethanol)(?=$|[^\p{L}\p{N}])/iu.test(`${input.name ?? ''} ${input.text ?? ''}`) || input.category === 'drink' &&
    // Swedish beer in a product name; German Öl in a composition means oil. UI locale does not identify label language.
    /(?:^|[^\p{L}\p{N}])öl(?=$|[^\p{L}\p{N}])/iu.test(input.name ?? '');
}

const aliasRules = new Map(rulesData.rules.flatMap(rule => rule.aliases.map(alias => [normalizeTerm(alias), rule] as const)));
const qualifierDomains = Object.values(rulesData.extendedMatching.animalQualifiers).map(domain => ({ qualifiers: domain.qualifiers.map(normalizeTerm).join('|'), rules: new Set(domain.rules) }));
const animalQualifiers = qualifierDomains.map(domain => domain.qualifiers).join('|');
const freeFromHeads = new Set(rulesData.extendedMatching.freeFromHeads.map(normalizeTerm));
// A free-from suffix ("milk-free", "laktosefrei", "glutenfreie", "mjölkfritt", "fleischlos").
const freeFrom = 'free|frei(?:e[rsmn]?)?|fri(?:tt|a)?|los(?:e[rsmn]?)?|vrije?';
// A negation covers the ingredient it introduces: the words up to the first plant or ambiguous ingredient ("no added sugar milk chocolate" keeps milk)
// or the hyphenated word ("non-GMO whole milk"), and a conjunction carries it on ("without milk and eggs", "no milk or eggs"). A negation fused with
// an animal qualifier ("non-dairy milk", "animal-free collagen", "tierfreies Kollagen", "fleischlose Wurst") keeps covering the following ingredient within the qualifier's domain
// ("dairy-free egg noodles" keeps the egg); the domains are data, and an empty domain covers every rule.
// A bare Finnish "ei" is never a negation: it is the German egg ("Ei und Milch"); only its fixed phrases ("ei sisällä", "ei lisättyä") are.
const qualified = (qualifiers: string) => String.raw`(?:non|nicht|icke)[-–]?(?:${qualifiers})\p{L}{0,2}|(?:${qualifiers})[-–]?\s?(?:${freeFrom})`;
const domainNegations = qualifierDomains.map(domain => ({ pattern: new RegExp(`^(?:${qualified(domain.qualifiers)})$`, 'u'), rules: domain.rules }));
const negations = String.raw`${qualified(animalQualifiers)}|no|non|not|without|ohne|kein\w*|utan|ingen|inget|inga|inte|ej|uten|uden|ikke|ilman|ei sisällä|ei lisättyä|sans|sin|senza|traces?|spuren|spår|spor|zonder|geen|free (?:from|of)|frei von|fri från|vrij van|libre de|privo di`;
// A substitute, flavour or culture word only covers its own phrase ("natural flavouring and milk powder" contains milk powder).
const modifiers = String.raw`vegan\w*|plant|plant-based|pflanzlich\w*|växtbaserad\w*|vegetabilisk\w*|faux|fake|artificial|künstlich\w*|synthetic\w*|synthetisch\w*|kunst\w*|konst\w*|syntet\w*|imitation\w*|imitiert\w*|imitat|ersatz|alternative|alternativ|ersättning|erstatning|substitute|replacer|flavou?r\w*|aroma\w*|ar[oô]m\w*|geschmack\w*|smak\w*|saveur\w*|go[uû]t\w*|sabor\w*|gusto\w*|smaak\w*|smag\w*|maku\w*|vegaan\w*|(?<!\p{L})(?:cultures?|kultur\w*)`;
const negatedBefore = new RegExp(String.raw`(?:^|[^\p{L}])(?:${negations})(?:$|[^\p{L}])`, 'u');
const negationWord = new RegExp(String.raw`(?:^|[^\p{L}])(?:${negations})(?=$|[^\p{L}])`, 'gu');
const modifiedBefore = new RegExp(String.raw`(?:^|[^\p{L}])(?:${modifiers})(?:$|[^\p{L}])`, 'u');
// A free-from suffix covers the word it is attached to, a head noun of the claim and a conjunction list before it ("milk-free", "milk protein-free", "milk and egg free", "milch- und eifrei"), not "milk from free range cows".
const freeSuffix = new RegExp(String.raw`(?:${freeFrom})(?=$|[^\p{L}])`, 'u');
const modifiedAfter = new RegExp(String.raw`(?:${modifiers})(?:$|[^\p{L}])`, 'u');
// A with-word starts a new phrase ("plant oil with milk", "milk powder with natural flavouring", "no added sugar and contains whole milk"); a conjunction also ends a modifier's phrase ("plant oil or milk", "arôme et viande"), and so does a slash
// ("natural flavouring / milk powder") unless a hyphen shares one head across it ("Huhn-/Pouletgeschmack", "mjölk-/mælkepulver"). Both word lists are data shared with Android and match whole words only, so "y", "o" and "e" never match inside a word or an E-number.
const withWords = rulesData.extendedMatching.withWords.map(normalizeTerm).join('|');
const conjunctions = rulesData.extendedMatching.conjunctions.map(normalizeTerm).join('|');
const phrase = new RegExp(String.raw`(?:^|[^\p{L}\p{N}])(?:${withWords})(?=$|[^\p{L}\p{N}])`, 'u');
const conjunct = new RegExp(String.raw`(?:^|[^\p{L}\p{N}])(?:${withWords}|${conjunctions}|&)(?=$|[^\p{L}\p{N}])|(?<![-–])/`, 'u');
const conjunction = new RegExp(`^(?:${conjunctions}|&|/)$`, 'u');
const words = (value: string) => value.match(/[\p{L}\p{N}]+|[&/]/gu) ?? [];
// An alias that reads as a negation or modifier itself ("pflanzlich gegerbtes Leder") or doubles as a word of another language ("ei": Finnish "not", Romanian "they") only matches exactly; inside longer text it is as likely an OCR fragment as an egg.
const exactOnlyAliases = new Set(rulesData.extendedMatching.exactOnlyAliases.map(normalizeTerm));
// A listed context lets an exact-only alias count as a word: a German adjective before it or a German preposition after it ("frisches Ei", "Ei aus Freilandhaltung").
type Context = { before: RegExp; after: RegExp };
const exactOnlyContexts = rulesData.extendedMatching.exactOnlyContexts.map(context => ({ alias: normalizeTerm(context.alias), context: {
  before: new RegExp(String.raw`(?:^|[^\p{L}\p{N}])(?:${context.before})\s+$`, 'u'), after: new RegExp(String.raw`^\s+(?:${context.after})(?=$|[^\p{L}\p{N}])`, 'u') } satisfies Context }));
const animalAliases = [...aliasRules].filter(([alias, rule]) => rule.status === 'animal' && !exactOnlyAliases.has(alias) && !negatedBefore.test(alias) && !modifiedBefore.test(alias)).map(([alias]) => alias).sort((a, b) => b.length - a.length);
const compoundStems = rulesData.extendedMatching.compoundStems.map(normalizeTerm).sort((a, b) => b.length - a.length);
const plantExceptions = rulesData.extendedMatching.plantExceptions.map(normalizeTerm).sort((a, b) => b.length - a.length);
/** The last negation before the mention still covers it unless it names another domain or a plant or ambiguous ingredient (or the hyphenated word) closed its scope without a conjunction reopening it. */
function negated(before: string, ruleId: string): boolean {
  const matches = [...before.matchAll(negationWord)];
  const last = matches[matches.length - 1];
  if (!last) return false;
  const domain = domainNegations.find(item => item.pattern.test(last[0].replace(/^[^\p{L}]+/u, '')));
  if (domain?.rules.size && !domain.rules.has(ruleId)) return false;
  const rest = before.slice(last.index + last[0].length);
  let open = true, bound = /^[-–]/u.test(rest);
  for (const word of words(rest)) {
    if (conjunction.test(word)) { open = true; continue; }
    if (open && (bound || ['plant', 'ambiguous'].includes(aliasRules.get(word)?.status ?? ''))) open = false;
    bound = false;
  }
  return open;
}
/** A free-from suffix covers the mention inside the same word ("Milcheiweißfrei"), behind a head noun of the claim ("milk protein-free", "dairy ingredient-free") or across conjunction-led words only; a separate word glued to the suffix must itself be an ingredient ("eifrei", not "cellulose"). */
function freed(after: string): boolean {
  const match = freeSuffix.exec(after);
  if (!match) return false;
  let between = after.slice(0, match.index);
  const head = /\p{L}+(?=[^\p{L}]*$)/u.exec(between);
  if (head && freeFromHeads.has(head[0])) between = between.slice(0, head.index);
  const list = words(between);
  if (/^\p{L}*$/u.test(between)) return true;
  for (let index = 0; index < list.length; index += 2) if (!conjunction.test(list[index]!) || !list[index + 1] || conjunction.test(list[index + 1]!)) return false;
  return !/\p{L}$/u.test(between) || aliasRules.has(list[list.length - 1]!);
}
/** A stem is a compound component when the letters attached to it could be words themselves: none or at least three before ("Kuhmilch"), none or at least four after ("Milchpulver"). Inflections such as "milchig", "wollen", "silken", "gräddes" or "Flachs" never count, and a stem shorter than four letters ("ägg") must start its word. */
function component(prefix: number, stem: string, suffix: number): boolean {
  return (prefix === 0 || prefix >= 3 && stem.length >= 4) && (suffix === 0 || suffix >= 4);
}
// Negation, modifier and free-from scopes on real labels span far less than this, so each mention only looks this far around itself and repeated mentions stay linear.
// The window ends on word boundaries, so a cut word never reads as "no" or "free", and a scope cut off by it can only make a mention count, never hide one.
const scopeWindow = 300;
const wordCharacter = /[\p{L}\p{N}]/u;
/** The item occurs (as a whole word, or as a compound stem forming a component, in its required context if any) without a negation or modifier covering that occurrence. */
function mentioned(text: string, item: string, wholeWord: boolean, context?: Context): boolean {
  for (let start = text.indexOf(item); start >= 0; start = text.indexOf(item, start + 1)) {
    const end = start + item.length;
    let from = Math.max(0, start - scopeWindow), to = Math.min(text.length, end + scopeWindow);
    if (from > 0) while (from < start && wordCharacter.test(text[from - 1]!)) from++;
    if (to < text.length) while (to > end && wordCharacter.test(text[to]!)) to--;
    const before = text.slice(from, start), after = text.slice(end, to);
    if (wholeWord) { if (wordCharacter.test(text[start - 1] ?? '') || wordCharacter.test(text[end] ?? '')) continue; }
    else if (!component(/\p{L}*$/u.exec(before)![0].length, item, /^\p{L}*/u.exec(after)![0].length)) continue;
    if (context && !context.before.test(before) && !context.after.test(after)) continue;
    if (negated(before.split(phrase).pop()!, aliasRules.get(item)?.id ?? '') || modifiedBefore.test(before.split(conjunct).pop()!)) continue;
    if (freed(after.split(phrase)[0]!) || modifiedAfter.test(after.split(conjunct)[0]!)) continue;
    return true;
  }
  return false;
}
/** How far whole-word animal alias occurrences reach: `at[i]` from an occurrence starting at `i`, `before[i]` from any occurrence starting earlier. One scan per term keeps stripping thousands of exceptions near-linear. */
function animalReach(term: string): { at: Int32Array; before: Int32Array } {
  const at = new Int32Array(term.length + 1), before = new Int32Array(term.length + 1);
  for (const alias of animalAliases) {
    for (let start = term.indexOf(alias); start >= 0; start = term.indexOf(alias, start + 1)) {
      const end = start + alias.length;
      if (!/[\p{L}\p{N}]/u.test(term[start - 1] ?? '') && !/[\p{L}\p{N}]/u.test(term[end] ?? '')) at[start] = Math.max(at[start]!, end);
    }
  }
  for (let index = 1; index <= term.length; index++) before[index] = Math.max(before[index - 1]!, at[index - 1]!);
  return { at, before };
}
/** A plant exception is blanked where it starts a word ("oat milk powder", not "goat milk powder") or follows a compound modifier of at least three letters ("walnut butter", "Tomatfruktkött"), unless a whole-word animal alias starts before it and reaches into it ("Griskött" over "skött") or starts with it and outgrows it ("Fischgräten" over "Fischgrät"); an inflection or compound tail after it keeps its plant head ("beef tomatoes", "king oysters", "Hafermilchkonzentrat"). Blanks keep the term's length, so the reach measured once on the term stays aligned. */
function withoutPlantExceptions(term: string): string {
  let reach: ReturnType<typeof animalReach> | undefined;
  let value = term;
  for (const exception of plantExceptions) {
    for (let start = value.indexOf(exception); start >= 0; start = value.indexOf(exception, start + 1)) {
      const end = start + exception.length;
      let prefix = 0;
      while (/\p{L}/u.test(value[start - prefix - 1] ?? '')) prefix++;
      if (!component(prefix, exception, 0)) continue;
      reach ??= animalReach(term);
      if (reach.before[start]! <= start && reach.at[start]! <= end) value = `${value.slice(0, start)}${' '.repeat(exception.length)}${value.slice(end)}`;
    }
  }
  return value;
}
const additiveNumber = /^e[\s-]?(\d{3,4}[a-h]?)(?:\s?\(?(?:i{1,3}|iv|v|vi)\)?)?$/u;
/** An exact alias wins; otherwise an unmodified animal alias as a whole word, or a compound stem, inside the term identifies the rule. */
export function ruleForTerm(term: string): (typeof rulesData.rules)[number] | undefined {
  // E numbers come spaced, hyphenated or with a roman subgroup ("e-471", "e500ii").
  const number = additiveNumber.exec(term)?.[1];
  const exact = aliasRules.get(term) ?? (number ? aliasRules.get(`e${number}`) : undefined);
  if (exact) return exact;
  const remainder = withoutPlantExceptions(term);
  const alias = animalAliases.find(item => mentioned(remainder, item, true)) ??
    exactOnlyContexts.find(item => mentioned(remainder, item.alias, true, item.context))?.alias ??
    compoundStems.find(stem => mentioned(remainder, stem, false));
  return alias ? aliasRules.get(alias) : undefined;
}
const heading = /(?:^|\n)[^\S\r\n]*(?:ingredients|ingredienser|zutaten|materials|material|zusammensetzung|composition|ingrédients|ingredientes|ingredienti|ingrediënten|ingredienten|ainesosat|ainekset)\s*:\s*/i;
const precaution = /\b(?:may contain|kan innehålla spår av|kann spuren von|kann\b[^.!]*\benthalten|spuren von|peut contenir|traces? (?:éventuelles? )?de|(?:fabriqu[ée]e?s?|produits?) dans une? (?:atelier|usine)|puede contener|trazas de|(?:elaborad|fabricad)[oa]s? en una? (?:fábrica|instalaci[óo]n|planta)|pu[oò] contenere|tracce di|prodott[oa] in uno stabilimento|kan\b[^.!]*\bbevatten|sporen van|kan inneholde|kan indeholde|spor av|spor af|(?:voi|saattaa) sisältää|jäämiä)(?![\p{L}\p{N}])(?!\s+(?:one or more|either|any (?:one )?of|une? ou plusieurs|l'une? des|uno o (?:más|varios)|alguno de|uno o più|uno dei|een of meer|en eller flere|ett eller flera|én eller flere|yksi tai useampi)(?![\p{L}\p{N}])(?![^.:;)]*(?:allerg|trace|traza|tracc|spor|spår|jäämi)))/iu;
export function analyzeText(value: CheckInput | string, now: () => Date = () => new Date(), parsedIngredients?: string[]): CheckResult {
  const input: CheckInput = typeof value === 'string' ? { text: value } : value;
  const locale = input.locale ?? 'en';
  const message = analysisMessages[locale];
  const t = resultMessages[locale];
  const text = (input.text ?? '').slice(0, 20_000);
  const checkedAt = now().toISOString();
  const sourceId = 'composition';
  const evidence: Evidence[] = text ? [{
    id: sourceId, kind: 'user_text', title: t.suppliedComposition,
    excerpt: text, retrievedAt: checkedAt,
    ...(safeSourceUrl(input.sourceUrl) ? { url: safeSourceUrl(input.sourceUrl) } : {}),
  }] : [];
  const headingMatch = heading.exec(text);
  const materialMatch = !headingMatch && ['shoes', 'clothing', 'other'].includes(input.category ?? 'other') ? materialSection.exec(text) : null;
  const body = headingMatch ? text.slice(headingMatch.index + headingMatch[0].length) : materialMatch ? text.slice(materialMatch.index).trim() : text;
  const precautionMatch = precaution.exec(body);
  const ingredients = precautionMatch ? body.slice(0, precautionMatch.index) : body;
  const crossContact = precautionMatch ? [body.slice(precautionMatch.index).trim()] : [];
  // A barcode identifies a product; it is not a composition term.
  const identityOnly = !headingMatch && !input.complete && input.name && normalizeTerm(ingredients) === normalizeTerm(input.name) && !aliasRules.has(normalizeTerm(ingredients));
  const fallback = normalizeBarcode(ingredients) || identityOnly ? [] : compositionTerms(ingredients, ['shoes', 'clothing'].includes(input.category ?? 'other'));
  const parsed = parseSourceIngredients(text, parsedIngredients);
  // AI selects the actual ingredients; local animal/ambiguous rules remain a veto
  // even when an ingredient is omitted or hidden inside a misleading compound.
  const status = (term: string) => ruleForTerm(term)?.status;
  // The ingredient after a role prefix is the guard, but an animal whole term outranks a plant or ambiguous suffix ("Milchschokolade: Zucker", "Milchschokolade: E471").
  const guards = fallback.flatMap(term => {
    const candidates = term.includes(':') ? [normalizeTerm(term.slice(term.lastIndexOf(':') + 1)), term] : [term];
    const guard = candidates.find(item => status(item) === 'animal') ?? candidates.find(item => status(item) === 'ambiguous');
    return guard ? [guard] : [];
  });
  const tokens = parsed ? [...parsed, ...guards] : fallback;
  const findings: Finding[] = [...new Set(tokens)].map(term => {
    const rule = ruleForTerm(term);
    return rule ? {
      term, status: rule.status as Finding['status'], ruleId: rule.id,
      // Rule explanations are maintained in English and German; other locales read the English text.
      explanation: (rule.explanation as Partial<Record<Locale, string>>)[locale] ?? rule.explanation.en, evidenceId: sourceId,
    } : { term, status: 'unknown', explanation: message.unknown, evidenceId: sourceId };
  });
  const category = input.category ?? 'other';
  const complete = (input.text?.length ?? 0) <= 20_000 && (input.complete ?? Boolean(headingMatch));
  const hasAnimal = findings.some(finding => finding.status === 'animal');
  const allKnown = findings.length > 0 && findings.every(finding => finding.status === 'plant');
  const extraProof = ['clothing', 'shoes', 'other'].includes(category) || needsProcessingEvidence(input);
  const outcome = hasAnimal ? 'not_vegan' : complete && allKnown && !extraProof ? 'vegan' : 'uncertain';
  const questions: string[] = [];
  if (outcome === 'uncertain') {
    if (!complete || !findings.length) questions.push(message.incomplete);
    if (findings.some(finding => finding.status === 'unknown' || finding.status === 'ambiguous')) questions.push(message.origin);
    if (category === 'clothing' || category === 'shoes') questions.push(message.shoes);
    if (needsProcessingEvidence(input)) questions.push(message.drink);
    if (category === 'other') questions.push(message.other);
  }
  return {
    schemaVersion: 1, id: crypto.randomUUID(), outcome,
    basis: outcome === 'uncertain' ? 'insufficient' : 'composition',
    title: outcome === 'not_vegan' ? message.animal : outcome === 'vegan' ? message.vegan : message.uncertain,
    summary: outcome === 'not_vegan' ? message.animalSummary : outcome === 'vegan' ? message.veganSummary : message.uncertainSummary,
    category, identity: { name: input.name, brand: input.brand, barcode: input.barcode, market: input.market ?? 'DE', match: 'unconfirmed' },
    findings, evidence, questions, warnings: [message.caveat], crossContact,
    companyConcerns: [], checkedAt, usedAI: false,
    ...(parsedIngredients !== undefined && text.trim() && !parsed ? { warnings: [message.caveat, t.aiIngredientsMismatch] } : {}),
  };
}

export function safeSourceUrl(value?: string): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : undefined;
  } catch { return undefined; }
}
