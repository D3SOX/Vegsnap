import { analysisMessages, resultMessages } from './i18n';
import type { Locale } from './types';

const locales = Object.keys(resultMessages) as Locale[];
const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Matches the fixed text before the first placeholder of any given message, so copy edits cannot silently break recognition. */
function startsWithAny(messages: string[]): RegExp {
  return new RegExp(`^(?:${messages.map(message => escapeRegExp(message.split(/\{[a-zA-Z_]\w*\}/)[0]!)).join('|')})`);
}
export const marketWarning = startsWithAny(locales.flatMap(locale => [resultMessages[locale].countryMismatchWarning, resultMessages[locale].offlineMarketMismatch]));
export const genericOriginQuestion = startsWithAny(locales.map(locale => analysisMessages[locale].origin));
const originQuestions = locales.map(locale => [locale, startsWithAny([resultMessages[locale].originQuestionPrefix, analysisMessages[locale].origin])] as const);
/** The locale of a generic or term-specific origin question, if the question is one. */
export function originQuestionLocale(question: string): Locale | undefined {
  return originQuestions.find(([, pattern]) => pattern.test(question))?.[0];
}
