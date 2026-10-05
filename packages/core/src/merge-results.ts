import type { CheckResult, Finding } from './types';

export function mergeResults(current: CheckResult, next: CheckResult): CheckResult {
  const contradictory = current.outcome === 'vegan' && next.outcome === 'not_vegan' || current.outcome === 'not_vegan' && next.outcome === 'vegan';
  const preferred = current.outcome === 'conflicting' || current.outcome !== 'uncertain' && next.outcome === 'uncertain' ? current : next;
  const findings = new Map<string, Finding>();
  for (const finding of [...next.findings, ...current.findings]) {
    const key = `${finding.term}:${finding.status}`;
    const previous = findings.get(key);
    findings.set(key, { ...finding, ...(!finding.displayTerm && previous?.displayTerm ? { displayTerm: previous.displayTerm, displayLocale: previous.displayLocale } : {}) });
  }
  return {
    ...preferred, id: current.id,
    identity: current.identity.match === 'exact_barcode' ? current.identity : next.identity.match === 'exact_barcode' ? next.identity : preferred.identity,
    ...(contradictory ? { outcome: 'conflicting' as const, basis: 'insufficient' as const, title: 'Conflicting evidence',
      summary: 'The supplied composition and another source disagree. Check the product variant and source dates.' } : {}),
    evidence: [...new Map([...current.evidence, ...next.evidence].map(item => [item.id, item])).values()],
    findings: [...findings.values()],
    warnings: [...new Set([...current.warnings, ...next.warnings])],
    crossContact: [...new Set([...current.crossContact, ...next.crossContact])],
    companyConcerns: current.companyConcerns,
    usedAI: current.usedAI || next.usedAI,
    aiStatus: current.aiStatus ?? next.aiStatus,
    webSearchStatus: current.webSearchStatus ?? next.webSearchStatus,
  };
}
