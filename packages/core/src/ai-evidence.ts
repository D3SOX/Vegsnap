import { resultMessages } from './i18n';
import { analyzeText, parseSourceIngredients, compositionTerms, normalizeTerm, needsProcessingEvidence } from './analyze';
import { mergeResults, withoutCompositionFindings } from './merge-results';
import type { AIExtraction, CheckInput, CheckResult, Finding } from './types';

const veganCertifications = new Set(['v-label', 'v label', 'v-label vegan', 'v label vegan', 'vegan society', 'the vegan society', 'vegan society trademark', 'vegan trademark', 'vegan flower', 'veganblume', 'veganblomman', 'certified vegan', 'vegan action']);

/** Model evidence stays explicitly attributed and cannot rewrite a known local ingredient rule. */
export function applyAIEvidence(result: CheckResult, input: CheckInput, extracted: AIExtraction, complete: boolean): CheckResult {
  const de = input.locale === 'de';
  const t = resultMessages[de ? 'de' : 'en'];
  const sourceText = input.complete === true && input.text?.trim() ? input.text : extracted.text || input.text || '';
  const parsed = parseSourceIngredients(sourceText, extracted.ingredients);
  let compositionEvidenceId = 'composition';
  if (extracted.ingredients !== undefined) {
    const evaluated = analyzeText({ ...input, text: sourceText, complete }, () => new Date(result.checkedAt), extracted.ingredients);
    const canonical = (value: string) => value.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
    const source = result.evidence.find(item => ['composition', 'ai-extraction'].includes(item.id) && canonical(item.excerpt) === canonical(sourceText));
    // Re-parsing a photo transcription must reuse its AI source, not create a
    // second 'supplied text' card or leave findings tied to a discarded source.
    if (source) {
      compositionEvidenceId = source.id;
      evaluated.evidence = [];
      evaluated.findings = evaluated.findings.map(finding => ({ ...finding, evidenceId: source.id }));
    }
    result = mergeResults(parsed ? withoutCompositionFindings(result, sourceText) : result, evaluated);
  }
  const assessments = new Map<string, NonNullable<AIExtraction['ingredientAssessments']>[number]>();
  const composition = normalizeTerm(sourceText);
  for (const assessment of extracted.ingredientAssessments ?? []) {
    const key = normalizeTerm(assessment.term);
    const keys = new Set([key]);
    // Match the complete expression in this source before aligning a compound
    // assessment with the same component tokenizer used by the local rules.
    // A plant compound describes all its parts; animal/ambiguous status only
    // describes its outer ingredient and cannot be assigned to every child.
    if (!parsed && key && composition.includes(key)) {
      const terms = compositionTerms(assessment.term, ['shoes', 'clothing'].includes(input.category ?? 'other'));
      if (assessment.status === 'plant') terms.forEach(term => keys.add(term));
      else if ((terms.length === 1 || /[([{]/.test(assessment.term)) && terms[0]) keys.add(terms[0]);
    }
    for (const matchedKey of keys) {
      // A contradictory model assessment is not sufficient evidence to resolve an ingredient.
      const previous = assessments.get(matchedKey);
      assessments.set(matchedKey, previous && previous.status !== assessment.status
        ? { term: matchedKey, status: 'ambiguous', explanation: t.aiOriginConflict }
        : assessment);
    }
  }
  const findings: Finding[] = result.findings.map(finding => {
    const assessment = assessments.get(normalizeTerm(finding.term));
    const display = assessment?.translatedTerm && normalizeTerm(assessment.term) === normalizeTerm(finding.term)
      ? { ...finding, displayTerm: assessment.translatedTerm, displayLocale: input.locale ?? 'en' as const } : finding;
    if (finding.status !== 'unknown' || !assessment) {
      return parsed?.includes(normalizeTerm(finding.term)) && finding.status === 'unknown' && !assessment && finding.evidenceId === compositionEvidenceId
        ? { ...display, explanation: t.aiUnknownOrigin }
        : display;
    }
    return { ...display, status: assessment.status, evidenceId: 'ai-assessment',
      explanation: `${t.aiAssessment}: ${assessment.explanation}` };
  });
  const assessed = findings.filter(finding => finding.evidenceId === 'ai-assessment');
  let next: CheckResult = { ...result, findings };
  if (assessed.length) {
    next.evidence = [...next.evidence, { id: 'ai-assessment', kind: 'ai_extraction',
      title: t.aiIngredientAssessment,
      excerpt: assessed.map(item => `${item.term}: ${item.explanation}`).join('\n'),
      retrievedAt: next.checkedAt, verification: 'unverified' }];
    next.warnings = [...next.warnings, t.aiIngredientCaution];
    const animal = findings.some(item => item.status === 'animal');
    const allPlant = findings.length > 0 && findings.every(item => item.status === 'plant');
    if (next.outcome !== 'conflicting' && animal) {
      next = { ...next, outcome: next.outcome === 'vegan' ? 'conflicting' : 'not_vegan', basis: 'composition',
        title: t.animalDerivedContentFound,
        summary: t.aiAnimalCompositionSummary, questions: [] };
    } else if (next.outcome === 'uncertain' && complete && allPlant && !['clothing', 'shoes', 'other'].includes(next.category) && !needsProcessingEvidence({ ...input, category: next.category, name: extracted.name ?? input.name })) {
      next = { ...next, outcome: 'vegan', basis: 'composition', title: t.compositionAppearsVegan,
        summary: t.aiVeganCompositionSummary, questions: [] };
    }
  }
  if (next.outcome === 'uncertain') {
    const unresolved = findings.filter(item => item.status === 'unknown' || item.status === 'ambiguous').map(item => item.term);
    const generic = /^(?:Confirm the source of the ambiguous|Die Herkunft unklarer)/;
    next.questions = next.questions.filter(question => !generic.test(question));
    if (unresolved.length) next.questions.push(`${t.originQuestionPrefix}${unresolved.join(', ')}.`);
  }
  if (!input.images?.length) return next;
  const observations = (extracted.labelObservations ?? []).filter(label => /\bvegan\b/i.test(label.text) &&
    !/\b(?:vegetarian|vegetarisch|vegetarisk)\b/i.test(label.text) &&
    !/\b(?:not|non|nicht|kein|keine|inte|ej)\s*[-:]?\s*vegan\b/i.test(label.text) &&
    (label.kind === 'vegan_claim' || veganCertifications.has(normalizeTerm(label.name))));
  if (!observations.length) return next;
  const conflict = next.outcome === 'not_vegan' || next.outcome === 'conflicting' || findings.some(item => item.status === 'animal');
  const certifiedLogo = observations.some(item => item.kind === 'vegan_certification');
  return { ...next, outcome: conflict ? 'conflicting' : 'vegan', basis: conflict ? 'insufficient' : 'packaging',
    title: conflict ? t.conflictingEvidence : certifiedLogo ? t.veganLabelVisible : t.veganClaimVisible,
    summary: conflict ? t.aiLabelConflictSummary : t.aiLabelSummary,
    questions: conflict ? next.questions : [],
    evidence: [...next.evidence, ...observations.map((item, index) => ({ id: `ai-label-${index}`, kind: 'ai_extraction' as const,
      title: `${t.aiLabelTitle}: ${item.name}`, excerpt: item.text,
      retrievedAt: next.checkedAt, claim: 'vegan' as const, verification: 'unverified' as const }))],
    warnings: [...next.warnings, t.aiLabelCaution],
  };
}
