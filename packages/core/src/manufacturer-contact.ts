import messages from '../../../data/manufacturer-messages.json';
import type { AIExtraction, CheckInput, CheckResult, ManufacturerContact } from './types';

const identityKey = (value: string | undefined) => (value ?? '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
const wellFormed = (value: string) => value.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '\uFFFD');
const bounded = (value: string, limit: number) => {
  const end = limit < value.length && /[\uD800-\uDBFF]/.test(value.charAt(limit - 1)) && /[\uDC00-\uDFFF]/.test(value.charAt(limit)) ? limit - 1 : limit;
  return wellFormed(value.slice(0, end));
};
const plain = (value: string, limit: number) => bounded(value.replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim(), limit);
const unresolved = (result: CheckResult) => result.outcome === 'uncertain' || result.outcome === 'conflicting';

export function safeContactUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 2000 || /[\s\u0000-\u001f\u007f-\u009f]/u.test(value)) return false;
  try { const url = new URL(value); if (!url.hostname.includes('.') || url.hostname.endsWith('.local') || url.hostname.endsWith('.localhost') || /^[\d.]+$/.test(url.hostname) || url.hostname.includes(':')) return false; return url.protocol === 'https:' && !url.username && !url.password; } catch { return false; }
}
export function safeContactEmail(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 254 || value.includes('..')) return false;
  // A conservative ASCII mailbox subset, excluding URI/header characters and quoted local parts.
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9._+\-]{0,62}[A-Za-z0-9])?@[A-Za-z0-9](?:[A-Za-z0-9\-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9\-]*[A-Za-z0-9])?)+$/.test(value)) return false;
  const [local, domain] = value.split('@');
  return Boolean(local && local.length <= 64 && domain && domain.split('.').every(part => part.length <= 63));
}
/** Invalid optional contact data is ignored without discarding a useful product assessment. */
export function parseManufacturerContact(value: unknown): ManufacturerContact | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return;
  const contact = value as Record<string, unknown>;
  if (Object.keys(contact).some(key => !['email', 'url', 'sourceUrl', 'productName', 'brand'].includes(key)) ||
    !safeContactUrl(contact.sourceUrl) || ['productName', 'brand'].some(key => typeof contact[key] !== 'string' ||
      !contact[key].trim() || contact[key].length > 300 || /[\u0000-\u001f\u007f-\u009f]/.test(contact[key]))) return;
  if (contact.email !== undefined && !safeContactEmail(contact.email) || contact.url !== undefined && !safeContactUrl(contact.url) ||
    contact.email === undefined && contact.url === undefined) return;
  return { sourceUrl: contact.sourceUrl, productName: contact.productName as string, brand: contact.brand as string,
    ...(typeof contact.email === 'string' ? { email: contact.email } : {}), ...(typeof contact.url === 'string' ? { url: contact.url } : {}) };
}
export function applyManufacturerContact(result: CheckResult, input: CheckInput, extracted: AIExtraction): CheckResult {
  const { manufacturerContact: _previous, ...withoutContact } = result;
  const contact = parseManufacturerContact(extracted.contact);
  if (!unresolved(result) || !contact || !extracted.research?.searched) return withoutContact;
  const name = identityKey(extracted.name);
  const brand = identityKey(extracted.brand);
  if (!name || !brand || identityKey(contact.productName) !== name || identityKey(contact.brand) !== brand ||
    [input.name, result.identity.name].some(value => value && identityKey(value) !== name) ||
    [input.brand, result.identity.brand].some(value => value && identityKey(value) !== brand)) return withoutContact;
  const sources = new Set(extracted.research.sources.map(source => source.url));
  if (!sources.has(contact.sourceUrl) || contact.url && !sources.has(contact.url)) return withoutContact;
  return { ...withoutContact, manufacturerContact: contact };
}

export interface ManufacturerMessage { subject: string; body: string; mailto?: string; }
export type ManufacturerMessageLanguage = keyof typeof messages.templates;
export const manufacturerMessageLanguages = ['en', 'de', 'sv'] as const;
/** Draft only. No provider call, clipboard write, browser navigation or message send happens here. */
export function manufacturerMessage(result: CheckResult, locale: ManufacturerMessageLanguage = 'en'): ManufacturerMessage | undefined {
  const contact = parseManufacturerContact(result.manufacturerContact);
  if (!unresolved(result)) return;
  const copy = messages.templates[locale];
  const name = plain(contact?.productName ?? result.identity.name ?? '', 300);
  const brand = plain(contact?.brand ?? result.identity.brand ?? '', 300);
  const product = `${name || copy.thisProduct}${brand ? ` ${copy.by} ${brand}` : ''}`;
  const subject = plain(`${copy.subject}: ${name || copy.thisProduct}`, 200);
  const terms = [...new Set(result.findings.filter(finding => finding.status === 'ambiguous' || finding.status === 'unknown')
    .map(finding => plain(finding.displayLocale === locale ? finding.displayTerm ?? finding.term : finding.term, 100)).filter(Boolean))].slice(0, 15);
  const originQuestion = /^(?:Confirm the origin of:|Die Herkunft dieser Zutaten klären:|Bekräfta ursprunget för:)/;
  const questions = [...new Set(result.questions.map(question => {
    const translation = messages.questions.find(pair => Object.values(pair).includes(question));
    if (terms.length && (originQuestion.test(question) || translation?.en === 'Confirm the source of the ambiguous or unrecognized ingredients/materials.')) return '';
    return translation?.[locale] ?? question;
  }).map(question => plain(question, 200)).filter(Boolean))].slice(0, 15);
  if (terms.length) questions.push(`${copy.originQuestion} ${terms.join(', ')}.`);
  const body = bounded([
    copy.greeting, '', copy.request.replace('{product}', product),
    ...(result.identity.barcode ? [`${copy.barcode}: ${plain(result.identity.barcode, 30)}`] : []), '',
    ...(result.outcome === 'conflicting' ? [copy.conflict, ''] : []),
    ...(questions.length ? [copy.questions, ...questions.map(question => `- ${question}`), ''] : [copy.processing, '']),
    copy.specification, '', ...(contact ? [`${copy.source}: ${contact.sourceUrl}`, ''] : []), copy.thanks,
  ].join('\n'), 8000);
  return { subject, body, ...(contact?.email ? { mailto: `mailto:${encodeURIComponent(contact.email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}` } : {}) };
}
