import type { CheckResult, Evidence, Finding } from './types';
import { normalizeTerm } from './analyze';

export function mergeResults(current: CheckResult, next: CheckResult): CheckResult {
  const contradictory = current.outcome === 'vegan' && next.outcome === 'not_vegan' || current.outcome === 'not_vegan' && next.outcome === 'vegan';
  const preferred = current.outcome === 'conflicting' || current.outcome !== 'uncertain' && next.outcome === 'uncertain' ? current : next;
  const findings = new Map<string, Finding>();
  for (const finding of [...next.findings, ...current.findings]) {
    const key = `${finding.term}:${finding.status}`;
    const previous = findings.get(key);
    findings.set(key, { ...finding, ...(!finding.displayTerm && previous?.displayTerm ? { displayTerm: previous.displayTerm, displayLocale: previous.displayLocale } : {}) });
  }
  const evidence = [...new Map([...current.evidence, ...next.evidence].map(item => [item.id, item])).values()];
  return {
    ...preferred, id: current.id,
    identity: current.identity.match === 'exact_barcode' ? current.identity : next.identity.match === 'exact_barcode' ? next.identity : preferred.identity,
    ...(contradictory ? { outcome: 'conflicting' as const, basis: 'insufficient' as const, title: 'Conflicting evidence',
      summary: 'The supplied composition and another source disagree. Check the product variant and source dates.' } : {}),
    evidence,
    findings: withoutDatabaseRuleMisses([...findings.values()], evidence),
    warnings: [...new Set([...current.warnings, ...next.warnings])],
    crossContact: [...new Set([...current.crossContact, ...next.crossContact])],
    companyConcerns: current.companyConcerns,
    usedAI: current.usedAI || next.usedAI,
    aiStatus: current.aiStatus ?? next.aiStatus,
    webSearchStatus: current.webSearchStatus ?? next.webSearchStatus,
  };
}

/** Keep the established ingredient and its source instead of a duplicate database rule miss. */
export function withoutDatabaseRuleMisses(findings: Finding[], evidence: Evidence[]): Finding[] {
  const established = new Set(findings.filter(finding => finding.status !== 'unknown').flatMap(finding => {
    const term = normalizeTerm(finding.term);
    // A simple qualifier such as "shallot (Thailand)" still names the same plant ingredient.
    return finding.status === 'plant' ? [term, term.replace(/\s+\([^(),;]*\)$/, '')] : [term];
  }));
  const databaseSources = new Set(evidence.filter(item => item.kind === 'database').map(item => item.id));
  return findings.filter(finding => finding.status !== 'unknown' || !databaseSources.has(finding.evidenceId) || !established.has(normalizeTerm(finding.term)));
}

/** Replace tokenization only for the same supplied/AI-transcribed composition, retaining other sources. */
export function withoutCompositionFindings(result: CheckResult, text: string): CheckResult {
  const canonical = (value: string) => value.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
  const source = canonical(text);
  const ids = new Set(result.evidence.filter(item => ['composition', 'ai-extraction'].includes(item.id) && ['user_text', 'ai_extraction'].includes(item.kind) && canonical(item.excerpt) === source).map(item => item.id));
  return { ...result, findings: result.findings.filter(finding => !ids.has(finding.evidenceId)) };
}
