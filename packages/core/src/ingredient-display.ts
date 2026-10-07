import type { CheckResult, Locale } from './types';
import { reconcileOriginQuestions, withoutDatabaseRuleMisses } from './merge-results';

/** Presentation only: never feed translated words back into ingredient classification. */
export function localizeResult<T extends CheckResult>(result: T, locale: Locale): T {
  const findings = withoutDatabaseRuleMisses(result.findings, result.evidence).map(finding => {
    const translated = (finding.displayLocale === locale && typeof finding.displayTerm === 'string' && finding.displayTerm.trim() && finding.displayTerm.length <= 300 ? finding.displayTerm : undefined);
    const { displayTerm: _oldTerm, displayLocale: _oldLocale, ...source } = finding;
    return { ...source, ...(translated && translated !== finding.term ? { displayTerm: translated, displayLocale: locale } : {}) };
  });
  const questions = reconcileOriginQuestions(result.questions, findings, locale);
  return { ...result, findings, questions };
}
