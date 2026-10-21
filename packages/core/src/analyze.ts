import { analysisMessages, resultMessages } from './i18n';
import rulesData from '../../../data/rules.json';
import { normalizeBarcode } from './database';
import type { CheckInput, CheckResult, Evidence, Finding, Locale } from './types';

const additiveRoles = `(?:säuerungsmittel|säureregulator(?:en)?|farbstoff(?:e)?|emulgator(?:en)?|verdickungsmittel|stabilisator(?:en)?|konservierungsstoff(?:e)?|antioxidationsmittel|backtriebmittel|geliermittel|überzugsmittel|süßungsmittel|süssungsmittel|acidity regulators?|acidifiers?|colou?r(?:ing)?s?|emulsifiers?|thickeners?|stabilisers?|stabilizers?|preservatives?|antioxidants?|raising agents?|gelling agents?|glazing agents?|sweeteners?|surhetsreglerande medel|syror|färgämnen?|förtjockningsmedel|stabiliseringsmedel|emulgeringsmedel|konserveringsmedel|antioxidationsmedel|bakpulver|jäsmedel|sötningsmedel|geleringsmedel)`;
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
const animalAliases = [...aliasRules].filter(([, rule]) => rule.status === 'animal').map(([alias]) => alias).sort((a, b) => b.length - a.length);
const compoundStems = rulesData.extendedMatching.compoundStems.map(normalizeTerm);
const plantExceptions = rulesData.extendedMatching.plantExceptions.map(normalizeTerm).sort((a, b) => b.length - a.length);
// A negated, substituted, imitated or flavour-only mention of an animal ingredient does not prove its presence.
const exactOnly = /(?:^|[^\p{L}])(?:no|non|not|without|ohne|kein\w*|ei|utan|inga?|ej|sans|sin|senza|traces?|spuren|spår|cultures?|vegan\w*|plant|plant-based|pflanzlich\w*|växtbaserad\w*|vegetabilisk\w*|faux|artificial|künstlich\w*|synthetic\w*|synthetisch\w*|kunst\w*|konst\w*|syntet\w*|imitation\w*|imitiert\w*|flavou?r\w*|aroma\w*|arom\w*|geschmack\w*|smak\w*)(?:$|[^\p{L}])|(?:frei|free|fri|los|ersatz|imitat|alternative|alternativ|ersättning|substitute|replacer|aroma|geschmack|smak|kultur\w*)(?:$|[^\p{L}])/u;
/** An exact alias wins; otherwise an animal alias as a whole word, or a compound stem, inside the term identifies the rule. */
export function ruleForTerm(term: string): (typeof rulesData.rules)[number] | undefined {
  const exact = aliasRules.get(term);
  if (exact || exactOnly.test(term)) return exact;
  const remainder = plantExceptions.reduce((value, exception) => value.replaceAll(exception, ' '), term);
  const alias = animalAliases.find(item => containsWord(remainder, item)) ?? compoundStems.find(stem => remainder.includes(stem));
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
  const guards = fallback.map(term => term.includes(':') ? normalizeTerm(term.slice(term.lastIndexOf(':') + 1)) : term)
    .filter(term => ['animal', 'ambiguous'].includes(ruleForTerm(term)?.status ?? ''));
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
