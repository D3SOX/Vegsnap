import { analyzeText, safeSourceUrl } from './analyze';
import { applyAIEvidence } from './ai-evidence';
import { mergeResults } from './merge-results';
import type { AIExtraction, CheckInput, CheckResult, Evidence } from './types';

const identityKey = (value: string | undefined) => (value ?? '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();

/** The tool must actually have consulted the URL; a model-generated link alone is never evidence. */
export function applyWebEvidence(result: CheckResult, input: CheckInput, extracted: AIExtraction): CheckResult {
  if (!extracted.research?.searched) return result;
  const sources = new Map(extracted.research.sources.map(source => [source.url, source]));
  const de = input.locale === 'de';
  const consultedOnly = (): CheckResult => ({ ...result, evidence: [...result.evidence,
    ...[...sources.values()].filter(source => safeSourceUrl(source.url)).slice(0, 3).map((source, index): Evidence => ({
      id: `web-consulted-${index}`, kind: 'ai_extraction',
      title: `${de ? 'Bei der Webrecherche konsultiert' : 'Consulted during web research'}: ${source.title || new URL(source.url).hostname}`,
      excerpt: de ? 'Bei der Webrecherche konsultiert; keine passende produktspezifische Aussage bestätigt.' : 'Consulted during web research; no matching product-specific claim was established.',
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
    let evaluated = analyzeText(compositionInput, () => new Date(result.checkedAt));
    evaluated = applyAIEvidence(evaluated, compositionInput, { text: composition.text, complete: composition.complete,
      category: extracted.category, ingredientAssessments: extracted.ingredientAssessments }, composition.complete);
    evaluated.usedAI = true;
    evaluated.evidence = [{ id: evidenceId, kind: composition.sourceType === 'manufacturer' ? 'manufacturer' : 'ai_extraction',
      title: composition.sourceType === 'manufacturer' ? (de ? 'Zusammensetzung laut Hersteller (KI)' : 'Manufacturer composition (AI)') : (de ? 'Zusammensetzung laut Händler (KI)' : 'Retailer composition (AI)'),
      excerpt: composition.text, url: composition.url, retrievedAt: result.checkedAt, verification: 'unverified' },
      ...evaluated.evidence.filter(item => item.id === 'ai-assessment').map(item => ({ ...item, id: `${evidenceId}-assessment` }))];
    evaluated.findings = evaluated.findings.map(finding => ({ ...finding, evidenceId: finding.evidenceId === 'ai-assessment' ? `${evidenceId}-assessment` : evidenceId }));
    evaluated.warnings.push(de ? 'Zusammensetzung von KI aus einer Webquelle gelesen; Produktvariante und aktuelle Packung prüfen.' : 'Composition read by AI from a web source; verify the product variant and current packaging.');
    result = mergeResults(result, evaluated);
  }
  const claims = (extracted.webClaims ?? []).filter(claim => sources.has(claim.url) && safeSourceUrl(claim.url) &&
    identityKey(claim.productName) === name && identityKey(claim.brand) === brand);
  if (!claims.length) return compositions.length ? result : consultedOnly();
  const positive = claims.some(claim => claim.claim === 'vegan');
  const negative = claims.some(claim => claim.claim === 'not_vegan');
  const conflict = result.outcome === 'conflicting' || positive && (negative || result.outcome === 'not_vegan' || result.findings.some(item => item.status === 'animal')) || negative && result.outcome === 'vegan';
  const manufacturer = claims.some(claim => claim.sourceType === 'manufacturer');
  const evidence: Evidence[] = claims.map((claim, index) => ({
    id: `web-claim-${index}`, kind: claim.sourceType === 'manufacturer' ? 'manufacturer' : 'certification',
    title: sources.get(claim.url)?.title || (claim.sourceType === 'manufacturer' ? claim.brand : de ? 'Zertifizierungsquelle' : 'Certification source'),
    excerpt: claim.quote, url: claim.url, retrievedAt: result.checkedAt, claim: claim.claim, verification: 'unverified',
  }));
  return { ...result, outcome: conflict ? 'conflicting' : positive ? 'vegan' : 'not_vegan',
    basis: conflict ? 'insufficient' : manufacturer ? 'manufacturer' : 'research',
    title: conflict ? (de ? 'Widersprüchliche Belege' : 'Conflicting evidence') : negative ? (de ? 'Laut Quelle nicht vegan' : 'Source says not vegan') : manufacturer ? (de ? 'Hersteller bezeichnet es als vegan' : 'Manufacturer says vegan') : (de ? 'Zertifizierungsquelle bezeichnet es als vegan' : 'Certification source says vegan'),
    summary: conflict ? (de ? 'Die recherchierte Quelle widerspricht anderen Belegen. Produktvariante und Originalquelle prüfen.' : 'The researched source conflicts with other evidence. Check the product variant and original source.') : (de ? 'Die KI hat eine produktspezifische Aussage in einer tatsächlich recherchierten Quelle gefunden. Die verlinkte Quelle prüfen.' : 'The AI found a product-specific statement in a source returned by web research. Review the linked source.'),
    questions: conflict ? result.questions : [], evidence: [...result.evidence, ...evidence],
    warnings: [...result.warnings, de ? 'Quelle von KI ausgewertet; Produktzuordnung und Aussage am Original prüfen. Keine unabhängige Registerprüfung.' : 'Source interpreted by AI; verify the product match and statement against the original. No independent registry verification.'],
  };
}
