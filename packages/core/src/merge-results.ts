import { resultMessages } from './i18n';
import type { CheckResult, Evidence, Finding, Locale } from './types';
import { normalizeTerm } from './analyze';

export function mergeResults(current: CheckResult, next: CheckResult): CheckResult {
  const contradictory = current.outcome === 'vegan' && next.outcome === 'not_vegan' || current.outcome === 'not_vegan' && next.outcome === 'vegan';
  const preferred = current.outcome === 'conflicting' || current.outcome !== 'uncertain' && next.outcome === 'uncertain' ? current : next;
  const evidence = [...new Map([...current.evidence, ...next.evidence].map(item => [item.id, item])).values()];
  const databaseSources = new Set(evidence.filter(item => item.kind === 'database').map(item => item.id));
  const findings = new Map<string, Finding>();
  for (const finding of [...next.findings, ...current.findings]) {
    // Separate database misses from assessments, retaining existing transcription deduplication.
    const key = `${finding.term}:${finding.status}${finding.status === 'unknown' && databaseSources.has(finding.evidenceId) ? `:${finding.evidenceId}` : ''}`;
    const previous = findings.get(key);
    findings.set(key, { ...finding, ...(!finding.displayTerm && previous?.displayTerm ? { displayTerm: previous.displayTerm, displayLocale: previous.displayLocale } : {}) });
  }
  const filtered = withoutDatabaseRuleMisses([...findings.values()], evidence);
  return {
    ...preferred, id: current.id,
    identity: current.identity.match === 'exact_barcode' ? current.identity : next.identity.match === 'exact_barcode' ? next.identity : preferred.identity,
    ...(contradictory ? { outcome: 'conflicting' as const, basis: 'insufficient' as const, title: resultMessages.en.conflictingEvidence,
      summary: resultMessages.en.compositionConflictSummary } : {}),
    evidence,
    findings: filtered,
    questions: filtered.length < findings.size ? reconcileOriginQuestions(preferred.questions, filtered) : preferred.questions,
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
    // The curry label's country of origin does not change the ingredient's identity.
    return finding.status === 'plant' ? [term, term.replace(/\s+\((?:thaimaa|thailand)\)$/, '')] : [term];
  }));
  const databaseSources = new Set(evidence.filter(item => item.kind === 'database').map(item => item.id));
  return findings.filter(finding => finding.status !== 'unknown' || !databaseSources.has(finding.evidenceId) || !established.has(normalizeTerm(finding.term)));
}

/** Keep existing origin questions aligned with the ingredients still requiring clarification. */
export function reconcileOriginQuestions(questions: string[], findings: Finding[], locale?: Locale): string[] {
  const unresolved = [...new Set(findings.filter(item => item.status === 'unknown' || item.status === 'ambiguous').map(item => locale ? item.displayTerm ?? item.term : item.term))];
  const originQuestion = /^(?:Confirm the origin of:|Die Herkunft dieser Zutaten klären:|Confirm the source of the ambiguous|Die Herkunft unklarer)/;
  return questions.flatMap(question => {
    if (!originQuestion.test(question)) return [question];
    const de = locale ? locale === 'de' : question.startsWith('Die Herkunft');
    const t = resultMessages[de ? 'de' : 'en'];
    return unresolved.length ? [`${t.originQuestionPrefix}${unresolved.join(', ')}.`] : [];
  });
}

/** Replace tokenization only for the same supplied/AI-transcribed composition, retaining other sources. */
export function withoutCompositionFindings(result: CheckResult, text: string): CheckResult {
  const canonical = (value: string) => value.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
  const source = canonical(text);
  const ids = new Set(result.evidence.filter(item => ['composition', 'ai-extraction'].includes(item.id) && ['user_text', 'ai_extraction'].includes(item.kind) && canonical(item.excerpt) === source).map(item => item.id));
  return { ...result, findings: result.findings.filter(finding => !ids.has(finding.evidenceId)) };
}
