import rulesData from '../../../data/rules.json';
import { normalizeBarcode } from './database';
import type { CheckInput, CheckResult, Evidence, Finding, Locale } from './types';

const additiveRoles = String.raw`(?:säuerungsmittel|säureregulator(?:en)?|farbstoff(?:e)?|emulgator(?:en)?|verdickungsmittel|stabilisator(?:en)?|konservierungsstoff(?:e)?|antioxidationsmittel|backtriebmittel|geliermittel|überzugsmittel|süßungsmittel|süssungsmittel|acidity regulators?|acidifiers?|colou?r(?:ing)?s?|emulsifiers?|thickeners?|stabilisers?|stabilizers?|preservatives?|antioxidants?|raising agents?|gelling agents?|glazing agents?|sweeteners?|surhetsreglerande medel|syror|färgämnen?|förtjockningsmedel|stabiliseringsmedel|emulgeringsmedel|konserveringsmedel|antioxidationsmedel|bakpulver|jäsmedel|sötningsmedel|geleringsmedel)`;
const additivePrefix = new RegExp(String.raw`^\s*${additiveRoles}(?:\s*:\s*|\s+)(?=\S)`, 'iu');
const additiveGroup = new RegExp(String.raw`\b${additiveRoles}\s*:?\s*(?=\(\s*[\p{L}\p{N}])`, 'giu');
const materialRoles = String.raw`(?:upper(?: material)?|lining|inner material|insole|outsole|sole|oberstoff|obermaterial|außenmaterial|aussenmaterial|innenmaterial|innensohle|decksohle|laufsohle|futter|sohle|ovandel|foder|innersula|yttersula)`;
const materialPrefix = new RegExp(String.raw`^\s*${materialRoles}\s*:\s*`, 'iu');
const materialSection = new RegExp(String.raw`(?:^|\n)\s*${materialRoles}\s*:`, 'iu');

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

/** Alcoholic/fermented beverage processing needs evidence; ordinary plant drinks do not inherit that veto. */
export function needsProcessingEvidence(input: CheckInput): boolean {
  return input.category === 'drink' && /(?:^|[^\p{L}\p{N}])(?:wine|wein|vin|viini|beer|bier|olut|ale|lager|cider|sidra|champagne|sekt|prosecco|alcohol|alkohol|ethanol)(?=$|[^\p{L}\p{N}])/iu.test(`${input.name ?? ''} ${input.text ?? ''}`) || input.category === 'drink' &&
    // Swedish beer in a product name; German Öl in a composition means oil. UI locale does not identify label language.
    /(?:^|[^\p{L}\p{N}])öl(?=$|[^\p{L}\p{N}])/iu.test(input.name ?? '');
}

const aliasRules = new Map(rulesData.rules.flatMap(rule => rule.aliases.map(alias => [normalizeTerm(alias), rule] as const)));
const heading = /(?:^|\n)\s*(?:ingredients|ingredienser|zutaten|materials|material|zusammensetzung|composition)\s*:\s*/i;
const precaution = /\b(?:may contain|kan innehålla spår av|kann spuren von|kann\b[^.!]*\benthalten|spuren von)\b/i;
const strings = {
  en: {
    animal: 'Animal-derived content found', vegan: 'Composition appears vegan', uncertain: 'More information needed',
    unknown: 'This term is not covered by the bundled rules.',
    incomplete: 'Provide the complete ingredients or materials list.',
    origin: 'Confirm the source of the ambiguous or unrecognized ingredients/materials.',
    shoes: 'Ask the manufacturer about lining, glue, coatings, and trims.',
    drink: 'Confirm processing and fining aids with the manufacturer.',
    other: 'Identify the product category and its complete composition.',
    caveat: 'Composition alone does not verify manufacturing aids or certification.',
    animalSummary: 'The supplied composition includes animal-derived content. See the matched terms and evidence.',
    veganSummary: 'All terms in the supplied complete list are covered without identified animal content. This is not a certification.',
    uncertainSummary: 'The available composition does not establish whether the product is vegan.',
  },
  de: {
    animal: 'Tierische Bestandteile gefunden', vegan: 'Zusammensetzung erscheint vegan', uncertain: 'Weitere Informationen nötig',
    unknown: 'Dieser Begriff ist in den enthaltenen Regeln nicht erfasst.',
    incomplete: 'Bitte die vollständige Zutaten- oder Materialliste angeben.',
    origin: 'Die Herkunft unklarer oder unbekannter Zutaten/Materialien muss bestätigt werden.',
    shoes: 'Den Hersteller nach Futter, Klebstoffen, Beschichtungen und Besatz fragen.',
    drink: 'Verarbeitungs- und Schönungsmittel beim Hersteller bestätigen lassen.',
    other: 'Produktkategorie und vollständige Zusammensetzung angeben.',
    caveat: 'Die Zusammensetzung bestätigt keine Verarbeitungshilfsmittel oder Zertifizierung.',
    animalSummary: 'Die angegebene Zusammensetzung enthält tierische Bestandteile. Die Treffer und Belege stehen unten.',
    veganSummary: 'Alle Begriffe der vollständigen Liste sind ohne erkannte tierische Bestandteile erfasst. Dies ist keine Zertifizierung.',
    uncertainSummary: 'Die vorhandene Zusammensetzung belegt nicht, ob das Produkt vegan ist.',
  },
} satisfies Record<Locale, Record<string, string>>;

export function analyzeText(value: CheckInput | string, now: () => Date = () => new Date()): CheckResult {
  const input: CheckInput = typeof value === 'string' ? { text: value } : value;
  const locale = input.locale ?? 'en';
  const message = strings[locale];
  const text = (input.text ?? '').slice(0, 20_000);
  const checkedAt = now().toISOString();
  const sourceId = 'composition';
  const evidence: Evidence[] = text ? [{
    id: sourceId, kind: 'user_text', title: locale === 'de' ? 'Angegebene Zusammensetzung' : 'Supplied composition',
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
  const tokens = normalizeBarcode(ingredients) || identityOnly ? [] : compositionTerms(ingredients, ['shoes', 'clothing'].includes(input.category ?? 'other'));
  const findings: Finding[] = [...new Set(tokens)].map(term => {
    const rule = aliasRules.get(term);
    return rule ? {
      term, status: rule.status as Finding['status'], ruleId: rule.id,
      explanation: rule.explanation[locale], evidenceId: sourceId,
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
  };
}

export function safeSourceUrl(value?: string): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : undefined;
  } catch { return undefined; }
}

/** Compose already verified product-specific evidence. Never pass model-authored claims here. */
export function applyVerifiedEvidence(result: CheckResult, evidence: Evidence[]): CheckResult {
  const usable = evidence.filter(item => Boolean(safeSourceUrl(item.url)) && (
    item.kind === 'certification' && (item.verification === 'registry' || item.verification === 'packaging') ||
    item.kind === 'manufacturer' && item.verification === 'source'
  ));
  const supports = usable.some(item => item.claim === 'vegan');
  const opposes = usable.some(item => item.claim === 'not_vegan');
  if (result.outcome === 'conflicting' || supports && (opposes || result.outcome === 'not_vegan') || opposes && result.outcome === 'vegan') {
    return { ...result, outcome: 'conflicting', basis: 'insufficient', title: 'Conflicting evidence',
      summary: 'Product-specific sources disagree. Review the evidence and the product variant.', evidence: [...result.evidence, ...usable] };
  }
  if (supports || opposes) {
    const basis = usable.some(item => item.kind === 'certification' && item.claim === 'vegan') ? 'certified' : 'manufacturer';
    return { ...result, outcome: supports ? 'vegan' : 'not_vegan', basis,
      title: opposes ? 'Not vegan' : basis === 'certified' ? 'Vegan certified' : 'Manufacturer says vegan',
      summary: 'See the product-specific source and its verification method.', questions: [], evidence: [...result.evidence, ...usable] };
  }
  return result;
}
