import { analysisMessages, resultMessages } from './i18n';
import rulesData from '../../../data/rules.json';
import { normalizeBarcode } from './database';
import type { CheckInput, CheckResult, Evidence, Finding, Locale } from './types';

const additiveRoles = `(?:säuerungsmittel|säureregulator(?:en)?|farbstoff(?:e)?|emulgator(?:en)?|verdickungsmittel|stabilisator(?:en)?|konservierungsstoff(?:e)?|antioxidationsmittel|backtriebmittel|geliermittel|überzugsmittel|süßungsmittel|süssungsmittel|acidity regulators?|acidifiers?|colou?r(?:ing)?s?|emulsifiers?|thickeners?|stabilisers?|stabilizers?|preservatives?|antioxidants?|raising agents?|gelling agents?|glazing agents?|sweeteners?|surhetsreglerande medel|syror|färgämnen?|förtjockningsmedel|stabiliseringsmedel|emulgeringsmedel|konserveringsmedel|antioxidationsmedel|bakpulver|jäsmedel|sötningsmedel|geleringsmedel|gelatineringsmedel)`;
const additivePrefix = new RegExp(String.raw`^\s*${additiveRoles}(?:\s*:\s*|\s+)(?=\S)`, 'iu');
const additiveGroup = new RegExp(String.raw`\b${additiveRoles}\s*:?\s*(?=\(\s*[\p{L}\p{N}])`, 'giu');
const materialRoles = `(?:upper(?: material)?|lining|inner material|insole|outsole|sole|oberstoff|obermaterial|außenmaterial|aussenmaterial|innenmaterial|innensohle|decksohle|laufsohle|futter|sohle|ovandel|foder|innersula|yttersula)`;
const materialPrefix = new RegExp(String.raw`^\s*${materialRoles}\s*:\s*`, 'iu');
const materialSection = new RegExp(String.raw`(?:^|\n)[^\S\r\n]*${materialRoles}\s*:`, 'iu');

export function normalizeTerm(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/[_*]/g, '').replace(/\d+(?:[.,]\d+)?\s*%/g, '')
    .replace(/\b(?:organic|bio)\b/g, '').replace(materialPrefix, '')
    .replace(additivePrefix, '').replace(/^\s*(?:gemüse|vegetables|grönsaker)\s*[-–:]\s*(?=\S)/iu, '')
    .replace(/\s+/g, ' ').trim().replace(/[.!]+$/, '').trim();
}

/** Discard typography notes only, retaining genuine allergen and subingredient text. */
export function compositionTerms(text: string, materialContext = false): string[] {
  let value = text.split('\n').filter(line => !/^\s*[*†]\s*(?:Allergioita tai intoleransseja aiheuttavat aineet korostettu|Ämnen som kan orsaka allergier eller intoleranser (?:är|har) markerade)\.?\s*$/i.test(line)).join('\n');
  const groups = [...value.matchAll(/\b(?:vitamins?|vitamine|vitaminer|vitamiinit)\s*\(/gi)];
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
  return input.category === 'drink' && /(?:^|[^\p{L}\p{N}])(?:wine|wein|vin|viini|beer|bier|olut|ale|lager|cider|sidra|champagne|sekt|prosecco|alcohol|alkohol|ethanol)(?=$|[^\p{L}\p{N}])/iu.test(`${input.name ?? ''} ${input.text ?? ''}`) || input.category === 'drink' &&
    // Swedish beer in a product name; German Öl in a composition means oil. UI locale does not identify label language.
    /(?:^|[^\p{L}\p{N}])öl(?=$|[^\p{L}\p{N}])/iu.test(input.name ?? '');
}

const aliasRules = new Map(rulesData.rules.flatMap(rule => rule.aliases.map(alias => [normalizeTerm(alias), rule] as const)));
const animalQualifiers = rulesData.extendedMatching.animalQualifiers.map(normalizeTerm).join('|');
const freeFromHeads = new Set(rulesData.extendedMatching.freeFromHeads.map(normalizeTerm));
// A free-from suffix ("milk-free", "laktosefrei", "glutenfreie", "mjölkfritt", "fleischlos").
const freeFrom = 'free|frei(?:e[rsmn]?)?|fri(?:tt|a)?|los(?:e[rsmn]?)?';
// A negation covers the ingredient it introduces: the words up to the first plant or ambiguous ingredient ("no added sugar milk chocolate" keeps milk)
// or the hyphenated word ("non-GMO whole milk"), and a conjunction carries it on ("without milk and eggs", "no milk or eggs"). A negation fused with
// an animal qualifier ("non-dairy milk", "animal-free collagen", "tierfreies Kollagen", "fleischlose Wurst") keeps covering the following ingredient.
// Only EN/DE/SV negations: the Finnish "ei" is the German egg ("Ei und Milch").
const negations = String.raw`(?:non|nicht|icke)[-–]?(?:${animalQualifiers})\p{L}{0,2}|(?:${animalQualifiers})[-–]?\s?(?:${freeFrom})|no|non|not|without|ohne|kein\w*|utan|ingen|inget|inga|inte|ej|sans|sin|senza|traces?|spuren|spår|free (?:from|of)|frei von|fri från`;
// A substitute, flavour or culture word only covers its own phrase ("natural flavouring and milk powder" contains milk powder).
const modifiers = String.raw`vegan\w*|plant|plant-based|pflanzlich\w*|växtbaserad\w*|vegetabilisk\w*|faux|fake|artificial|künstlich\w*|synthetic\w*|synthetisch\w*|kunst\w*|konst\w*|syntet\w*|imitation\w*|imitiert\w*|imitat|ersatz|alternative|alternativ|ersättning|substitute|replacer|flavou?r\w*|aroma\w*|ar[oô]m\w*|geschmack\w*|smak\w*|cultures?|kultur\w*`;
const negatedBefore = new RegExp(String.raw`(?:^|[^\p{L}])(?:${negations})(?:$|[^\p{L}])`, 'u');
const negationWord = new RegExp(String.raw`(?:^|[^\p{L}])(?:${negations})(?=$|[^\p{L}])`, 'gu');
const modifiedBefore = new RegExp(String.raw`(?:^|[^\p{L}])(?:${modifiers})(?:$|[^\p{L}])`, 'u');
// A free-from suffix covers the word it is attached to, a head noun of the claim and a conjunction list before it ("milk-free", "milk protein-free", "milk and egg free", "milch- und eifrei"), not "milk from free range cows".
const freeSuffix = new RegExp(String.raw`(?:${freeFrom})(?=$|[^\p{L}])`, 'u');
const modifiedAfter = new RegExp(String.raw`(?:${modifiers})(?:$|[^\p{L}])`, 'u');
// "with" starts a new phrase ("plant oil with milk", "milk powder with natural flavouring"); a conjunction also ends a modifier's phrase ("plant oil or milk"), and so does a slash
// ("natural flavouring / milk powder") unless a hyphen shares one head across it ("Huhn-/Pouletgeschmack", "mjölk-/mælkepulver").
const phrase = /(?:^|[^\p{L}])(?:with|mit|med)(?=$|[^\p{L}])/u;
const conjunct = /(?:^|[^\p{L}])(?:with|mit|med|and|und|och|or|oder|eller|&)(?=$|[^\p{L}])|(?<![-–])\//u;
const conjunction = /^(?:and|und|och|or|oder|eller|&|\/)$/u;
const words = (value: string) => value.match(/\p{L}+|[&/]/gu) ?? [];
// An alias that reads as a negation or modifier itself ("pflanzlich gegerbtes Leder") or doubles as a word of another language ("ei": Finnish "not", Romanian "they") only matches exactly; inside longer text it is as likely an OCR fragment as an egg.
const exactOnlyAliases = new Set(rulesData.extendedMatching.exactOnlyAliases.map(normalizeTerm));
const animalAliases = [...aliasRules].filter(([alias, rule]) => rule.status === 'animal' && !exactOnlyAliases.has(alias) && !negatedBefore.test(alias) && !modifiedBefore.test(alias)).map(([alias]) => alias).sort((a, b) => b.length - a.length);
const compoundStems = rulesData.extendedMatching.compoundStems.map(normalizeTerm).sort((a, b) => b.length - a.length);
const plantExceptions = rulesData.extendedMatching.plantExceptions.map(normalizeTerm).sort((a, b) => b.length - a.length);
/** The last negation before the mention still covers it unless a plant or ambiguous ingredient (or the hyphenated word) closed its scope without a conjunction reopening it. */
function negated(before: string): boolean {
  const matches = [...before.matchAll(negationWord)];
  const last = matches[matches.length - 1];
  if (!last) return false;
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
/** The item occurs (as a whole word, or as a compound stem forming a component) without a negation or modifier covering that occurrence. */
function mentioned(text: string, item: string, wholeWord: boolean): boolean {
  for (let start = text.indexOf(item); start >= 0; start = text.indexOf(item, start + 1)) {
    const end = start + item.length;
    if (wholeWord) { if (/[\p{L}\p{N}]/u.test(text[start - 1] ?? '') || /[\p{L}\p{N}]/u.test(text[end] ?? '')) continue; }
    else if (!component(/\p{L}*$/u.exec(text.slice(0, start))![0].length, item, /^\p{L}*/u.exec(text.slice(end))![0].length)) continue;
    const before = text.slice(0, start), after = text.slice(end);
    if (negated(before.split(phrase).pop()!) || modifiedBefore.test(before.split(conjunct).pop()!)) continue;
    if (freed(after.split(phrase)[0]!) || modifiedAfter.test(after.split(conjunct)[0]!)) continue;
    return true;
  }
  return false;
}
/** An exact alias wins; otherwise an unmodified animal alias as a whole word, or a compound stem, inside the term identifies the rule. */
export function ruleForTerm(term: string): (typeof rulesData.rules)[number] | undefined {
  const exact = aliasRules.get(term);
  if (exact) return exact;
  const remainder = plantExceptions.reduce((value, exception) => value.replaceAll(exception, ' '), term);
  const alias = animalAliases.find(item => mentioned(remainder, item, true)) ?? compoundStems.find(stem => mentioned(remainder, stem, false));
  return alias ? aliasRules.get(alias) : undefined;
}
const heading = /(?:^|\n)[^\S\r\n]*(?:ingredients|ingredienser|zutaten|materials|material|zusammensetzung|composition)\s*:\s*/i;
const precaution = /\b(?:may contain|kan innehålla spår av|kann spuren von|kann\b[^.!]*\benthalten|spuren von)\b/i;
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
