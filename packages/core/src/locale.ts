import type { Locale } from './types';

export const locales: readonly Locale[] = ['en', 'de', 'sv'];
/** Unknown or missing language codes read English result copy. */
export function appLocale(value: unknown): Locale {
  return locales.includes(value as Locale) ? value as Locale : 'en';
}
