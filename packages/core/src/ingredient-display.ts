import dictionary from '../../../data/ingredient-translations.json';
import type { CheckResult, Locale } from './types';

const normalized = (term: string) => term.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
const terms = new Map(dictionary.terms.flatMap(entry => entry.aliases.map(alias => [normalized(alias), entry] as const)));
export function translatedIngredient(term: string, locale: Locale): string | undefined {
  return terms.get(normalized(term))?.[locale];
}

/** Presentation only: never feed translated words back into ingredient classification. */
export function localizeResult<T extends CheckResult>(result: T, locale: Locale): T {
  const findings = result.findings.map(finding => {
    const translated = translatedIngredient(finding.term, locale) ??
      (finding.displayLocale === locale && typeof finding.displayTerm === 'string' && finding.displayTerm.trim() && finding.displayTerm.length <= 300 ? finding.displayTerm : undefined);
    const { displayTerm: _oldTerm, displayLocale: _oldLocale, ...source } = finding;
    return { ...source, ...(translated && translated !== finding.term ? { displayTerm: translated, displayLocale: locale } : {}) };
  });
  const unresolved = [...new Set(findings.filter(item => item.status === 'unknown' || item.status === 'ambiguous').map(item => item.displayTerm ?? item.term))];
  const originQuestion = /^(?:Confirm the origin of:|Die Herkunft dieser Zutaten klären:|Confirm the source of the ambiguous|Die Herkunft unklarer)/;
  const questions = result.questions.map(question => originQuestion.test(question) && unresolved.length
    ? `${locale === 'de' ? 'Die Herkunft dieser Zutaten klären: ' : 'Confirm the origin of: '}${unresolved.join(', ')}.` : question);
  return { ...result, findings, questions };
}
