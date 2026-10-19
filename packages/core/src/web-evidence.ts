import rulesData from '../../../data/rules.json';
import { resultMessages } from './i18n';
import { analyzeText, safeSourceUrl } from './analyze';
import { applyAIEvidence } from './ai-evidence';
import { mergeResults } from './merge-results';
import type { AIExtraction, CheckInput, CheckResult, Evidence } from './types';

const identityKey = (value: string | undefined) => (value ?? '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
const veganCertifiers: string[] = rulesData.veganCertifiers;
/** Approximate registrable domain without a suffix list: keep a third label for two-letter ccTLD second levels (co.uk). */
export function registrableDomain(host: string): string {
  const labels = host.toLowerCase().replace(/^www\./, '').split('.');
  return labels.slice(labels.length > 2 && labels.at(-2)!.length <= 3 && labels.at(-1)!.length === 2 ? -3 : -2).join('.');
}

/** The tool must actually have consulted the URL; a model-generated link alone is never evidence. */
export function applyWebEvidence(result: CheckResult, input: CheckInput, extracted: AIExtraction): CheckResult {
  if (!extracted.research?.searched) return result;
  const sources = new Map(extracted.research.sources.map(source => [source.url, source]));
  const de = input.locale === 'de';
  const t = resultMessages[de ? 'de' : 'en'];
  const consultedOnly = (): CheckResult => ({ ...result, evidence: [...result.evidence,
    ...[...sources.values()].filter(source => safeSourceUrl(source.url)).slice(0, 3).map((source, index): Evidence => ({
      id: `web-consulted-${index}`, kind: 'ai_extraction',
      title: `${t.consultedDuringWebResearch}: ${source.title || new URL(source.url).hostname}`,
      excerpt: t.webConsultedNotice,
      url: source.url, retrievedAt: result.checkedAt, verification: 'unverified',
    })),
  ] });
  const name = identityKey(extracted.name);
  const brand = identityKey(extracted.brand);
  if (!name || !brand || input.name && identityKey(input.name) !== name || input.brand && identityKey(input.brand) !== brand) return consultedOnly();
  const compositions = (extracted.webCompositions ?? []).filter(item => sources.has(item.url) && safeSourceUrl(item.url) &&
    identityKey(item.productName) === name && identityKey(item.brand) === brand);
  const ordered = [...compositions].sort((a, b) => Number(b.sourceType === 'manufacturer') - Number(a.sourceType === 'manufacturer'));
  for (const [index, composition] of ordered.entries()) {
    const evidenceId = `web-composition-${index}`;
    const compositionInput: CheckInput = { name: extracted.name, brand: extracted.brand, text: composition.text,
      complete: composition.complete, category: input.category && input.category !== 'other' ? input.category : extracted.category,
      locale: input.locale, market: input.market };
    let evaluated = analyzeText(compositionInput, () => new Date(result.checkedAt), composition.ingredients);
    evaluated = applyAIEvidence(evaluated, compositionInput, { text: composition.text, complete: composition.complete,
      category: extracted.category, ingredients: composition.ingredients, ingredientAssessments: extracted.ingredientAssessments }, composition.complete);
    evaluated.usedAI = true;
    evaluated.evidence = [{ id: evidenceId, kind: composition.sourceType === 'manufacturer' ? 'manufacturer' : 'ai_extraction',
      title: composition.sourceType === 'manufacturer' ? t.manufacturerCompositionAi : t.retailerCompositionAi,
      excerpt: composition.text, url: composition.url, retrievedAt: result.checkedAt, verification: 'unverified' },
      ...evaluated.evidence.filter(item => item.id === 'ai-assessment').map(item => ({ ...item, id: `${evidenceId}-assessment` }))];
    evaluated.findings = evaluated.findings.map(finding => ({ ...finding, evidenceId: finding.evidenceId === 'ai-assessment' ? `${evidenceId}-assessment` : evidenceId }));
    evaluated.warnings.push(t.webCompositionCaution);
    result = mergeResults(result, evaluated, input.locale);
  }
  const claims = (extracted.webClaims ?? []).filter(claim => sources.has(claim.url) && safeSourceUrl(claim.url) &&
    identityKey(claim.productName) === name && identityKey(claim.brand) === brand);
  if (!claims.length) return compositions.length ? result : consultedOnly();
  // Only a brand-owned site or a known certifier may settle a verdict; other positive claims are shown, never decisive.
  // The model's sourceType and contact are not ownership proof: the site name must equal the brand or one of its longer words.
  const brandKey = (value: string) => value.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]/g, '');
  const brandSites = new Set([brandKey(extracted.brand ?? ''), ...(extracted.brand ?? '').split(/\s+/).map(brandKey).filter(word => word.length >= 4)].filter(key => key.length >= 3));
  const trust = claims.map(claim => {
    const host = new URL(claim.url).hostname.toLowerCase();
    const site = registrableDomain(host);
    if (veganCertifiers.some(domain => host === domain || host.endsWith(`.${domain}`))) return 'certification' as const;
    if (claim.sourceType === 'manufacturer' && brandSites.has(site.split('.')[0]!.replace(/-/g, ''))) return 'manufacturer' as const;
    return undefined;
  });
  const evidence: Evidence[] = claims.map((claim, index) => ({
    id: `web-claim-${index}`, kind: trust[index] ?? 'ai_extraction',
    title: sources.get(claim.url)?.title || (trust[index] === 'manufacturer' ? claim.brand : trust[index] ? t.certificationSource : new URL(claim.url).hostname),
    excerpt: claim.quote, url: claim.url, retrievedAt: result.checkedAt, claim: claim.claim, verification: 'unverified',
  }));
  // Safety asymmetry: any consulted not-vegan claim may still contradict or reject.
  const settling = claims.filter((claim, index) => trust[index] || claim.claim === 'not_vegan');
  if (!settling.length) return { ...result, evidence: [...result.evidence, ...evidence], warnings: [...result.warnings, t.webSourceCaution] };
  const positive = settling.some(claim => claim.claim === 'vegan');
  const negative = settling.some(claim => claim.claim === 'not_vegan');
  const conflict = result.outcome === 'conflicting' || positive && (negative || result.outcome === 'not_vegan' || result.findings.some(item => item.status === 'animal')) || negative && result.outcome === 'vegan';
  const manufacturer = trust.includes('manufacturer');
  return { ...result, outcome: conflict ? 'conflicting' : positive ? 'vegan' : 'not_vegan',
    basis: conflict ? 'insufficient' : manufacturer ? 'manufacturer' : 'research',
    title: conflict ? t.conflictingEvidence : negative ? t.sourceSaysNotVegan : manufacturer ? t.manufacturerSaysVegan : t.certificationSourceSaysVegan,
    summary: conflict ? t.webResearchConflictSummary : t.webClaimSummary,
    questions: conflict ? result.questions : [], evidence: [...result.evidence, ...evidence],
    warnings: [...result.warnings, t.webSourceCaution],
  };
}
