import { localizeResult } from './ingredient-display';
import type { AIExtraction, CheckInput, CheckResult, Locale, ManufacturerContact } from './types';

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
/** Draft only. No provider call, clipboard write, browser navigation or message send happens here. */
export function manufacturerMessage(result: CheckResult, locale: Locale = 'en'): ManufacturerMessage | undefined {
  const contact = parseManufacturerContact(result.manufacturerContact);
  if (!contact || !unresolved(result)) return;
  const localized = localizeResult(result, locale);
  const de = locale === 'de';
  const name = plain(contact.productName, 300);
  const brand = plain(contact.brand, 300);
  const subject = plain(`${de ? 'Frage zum veganen Status' : 'Question about vegan status'}: ${name}`, 200);
  const questions = [...new Set(localized.questions.map(question => plain(question, 200)).filter(Boolean))].slice(0, 15);
  const terms = [...new Set(localized.findings.filter(finding => finding.status === 'ambiguous' || finding.status === 'unknown')
    .map(finding => plain(finding.displayTerm ?? finding.term, 100)).filter(Boolean))].slice(0, 15);
  const body = bounded([
    de ? 'Guten Tag,' : 'Hello,', '',
    de ? `ich möchte wissen, ob das Produkt ${name} von ${brand} vegan ist.` : `I would like to know whether ${name} by ${brand} is vegan.`,
    ...(result.identity.barcode ? [`Barcode: ${plain(result.identity.barcode, 30)}`] : []), '',
    ...(result.outcome === 'conflicting' ? [de ? 'Die mir vorliegenden Angaben widersprechen sich. Können Sie den aktuellen Stand für diese Produktvariante bestätigen?' : 'The available information conflicts. Could you confirm the current information for this product variant?', ''] : []),
    ...(questions.length ? [de ? 'Bitte helfen Sie mir bei diesen offenen Fragen:' : 'Could you help with these unresolved questions?', ...questions.map(question => `- ${question}`), ''] :
      [de ? 'Können Sie bestätigen, ob das Produkt einschließlich seiner Verarbeitungshilfsmittel vegan ist?' : 'Could you confirm whether the product, including its processing aids, is vegan?', '']),
    ...(terms.length ? [`${de ? 'Bei diesen Zutaten oder Materialien ist die Herkunft unklar' : 'The origin of these ingredients or materials is unclear'}: ${terms.join(', ')}.`, ''] : []),
    de ? 'Eine produktspezifische Angabe oder Spezifikation wäre hilfreich.' : 'A product-specific statement or specification would be helpful.', '',
    `${de ? 'Quelle der Kontaktdaten' : 'Contact source'}: ${contact.sourceUrl}`, '',
    de ? 'Vielen Dank.' : 'Thank you.',
  ].join('\n'), 8000);
  return { subject, body, ...(contact.email ? { mailto: `mailto:${encodeURIComponent(contact.email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}` } : {}) };
}
