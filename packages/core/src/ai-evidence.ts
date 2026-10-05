import { compositionTerms, normalizeTerm, needsProcessingEvidence } from './analyze';
import type { AIExtraction, CheckInput, CheckResult, Finding } from './types';

const veganCertifications = new Set(['v-label', 'v label', 'v-label vegan', 'v label vegan', 'vegan society', 'the vegan society', 'vegan society trademark', 'vegan trademark', 'vegan flower', 'veganblume', 'veganblomman', 'certified vegan', 'vegan action']);

/** Model evidence stays explicitly attributed and cannot rewrite a known local ingredient rule. */
export function applyAIEvidence(result: CheckResult, input: CheckInput, extracted: AIExtraction, complete: boolean): CheckResult {
  const de = input.locale === 'de';
  const assessments = new Map<string, NonNullable<AIExtraction['ingredientAssessments']>[number]>();
  const composition = normalizeTerm(input.complete === true && input.text?.trim() ? input.text : extracted.text || input.text || '');
  for (const assessment of extracted.ingredientAssessments ?? []) {
    const key = normalizeTerm(assessment.term);
    const keys = new Set([key]);
    // Match the complete expression in this source before aligning a compound
    // assessment with the same component tokenizer used by the local rules.
    // A plant compound describes all its parts; animal/ambiguous status only
    // describes its outer ingredient and cannot be assigned to every child.
    if (key && composition.includes(key)) {
      const terms = compositionTerms(assessment.term, ['shoes', 'clothing'].includes(input.category ?? 'other'));
      if (assessment.status === 'plant') terms.forEach(term => keys.add(term));
      else if ((terms.length === 1 || /[([{]/.test(assessment.term)) && terms[0]) keys.add(terms[0]);
    }
    for (const matchedKey of keys) {
      // A contradictory model assessment is not sufficient evidence to resolve an ingredient.
      const previous = assessments.get(matchedKey);
      assessments.set(matchedKey, previous && previous.status !== assessment.status
        ? { term: matchedKey, status: 'ambiguous', explanation: de ? 'Die KI macht widersprüchliche Angaben zur Herkunft.' : 'The AI gave conflicting ingredient origins.' }
        : assessment);
    }
  }
  const findings: Finding[] = result.findings.map(finding => {
    const assessment = assessments.get(normalizeTerm(finding.term));
    const display = assessment?.translatedTerm && normalizeTerm(assessment.term) === normalizeTerm(finding.term)
      ? { ...finding, displayTerm: assessment.translatedTerm, displayLocale: input.locale ?? 'en' as const } : finding;
    if (finding.status !== 'unknown' || !assessment) return display;
    return { ...display, status: assessment.status, evidenceId: 'ai-assessment',
      explanation: `${de ? 'KI-Einschätzung' : 'AI assessment'}: ${assessment.explanation}` };
  });
  const assessed = findings.filter(finding => finding.evidenceId === 'ai-assessment');
  let next: CheckResult = { ...result, findings };
  if (assessed.length) {
    next.evidence = [...next.evidence, { id: 'ai-assessment', kind: 'ai_extraction',
      title: de ? 'KI-Einschätzung der Zutaten' : 'AI ingredient assessment',
      excerpt: assessed.map(item => `${item.term}: ${item.explanation}`).join('\n'),
      retrievedAt: next.checkedAt, verification: 'unverified' }];
    next.warnings = [...next.warnings, de ? 'KI-Einschätzungen zur Herkunft sind keine Herstellerbestätigung.' : 'AI ingredient assessments are not manufacturer confirmation.'];
    const animal = findings.some(item => item.status === 'animal');
    const allPlant = findings.length > 0 && findings.every(item => item.status === 'plant');
    if (next.outcome !== 'conflicting' && animal) {
      next = { ...next, outcome: next.outcome === 'vegan' ? 'conflicting' : 'not_vegan', basis: 'composition',
        title: de ? 'Tierische Bestandteile gefunden' : 'Animal-derived content found',
        summary: de ? 'Die Zutatenbewertung weist auf tierische Bestandteile hin. Die KI-Einschätzung ist gekennzeichnet.' : 'The ingredient assessment identifies animal-derived content. AI assessments are marked.', questions: [] };
    } else if (next.outcome === 'uncertain' && complete && allPlant && !['clothing', 'shoes', 'other'].includes(next.category) && !needsProcessingEvidence({ ...input, category: next.category, name: extracted.name ?? input.name })) {
      next = { ...next, outcome: 'vegan', basis: 'composition', title: de ? 'Zusammensetzung erscheint vegan' : 'Composition appears vegan',
        summary: de ? 'In der vollständigen Zutatenliste wurden mit KI-Unterstützung keine tierischen Bestandteile erkannt.' : 'No animal-derived ingredients were identified in the complete list, with AI assistance.', questions: [] };
    }
  }
  if (next.outcome === 'uncertain') {
    const unresolved = findings.filter(item => item.status === 'unknown' || item.status === 'ambiguous').map(item => item.term);
    const generic = /^(?:Confirm the source of the ambiguous|Die Herkunft unklarer)/;
    next.questions = next.questions.filter(question => !generic.test(question));
    if (unresolved.length) next.questions.push(de ? `Die Herkunft dieser Zutaten klären: ${unresolved.join(', ')}.` : `Confirm the origin of: ${unresolved.join(', ')}.`);
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
    title: conflict ? (de ? 'Widersprüchliche Belege' : 'Conflicting evidence') : certifiedLogo ? (de ? 'Vegan-Label sichtbar' : 'Vegan label visible') : (de ? 'Vegane Kennzeichnung sichtbar' : 'Vegan claim visible'),
    summary: conflict ? (de ? 'Das sichtbare Vegan-Label widerspricht der Zutatenbewertung. Produktvariante und Belege prüfen.' : 'The visible vegan label conflicts with the ingredient assessment. Check the product variant and evidence.') : (de ? 'Die KI erkennt eine vegane Kennzeichnung auf dem bereitgestellten Produktfoto. Die Kennzeichnung am Original prüfen.' : 'The AI identified a vegan label on the supplied product photo. Verify the label against the original.'),
    questions: conflict ? next.questions : [],
    evidence: [...next.evidence, ...observations.map((item, index) => ({ id: `ai-label-${index}`, kind: 'ai_extraction' as const,
      title: `${de ? 'Sichtbare Kennzeichnung (KI)' : 'Visible packaging label (AI)'}: ${item.name}`, excerpt: item.text,
      retrievedAt: next.checkedAt, claim: 'vegan' as const, verification: 'unverified' as const }))],
    warnings: [...next.warnings, de ? 'Kennzeichnung von KI abgelesen; Echtheit und Zertifizierungsregister wurden nicht geprüft.' : 'Label read by AI; authenticity and certification registry were not checked.'],
  };
}
