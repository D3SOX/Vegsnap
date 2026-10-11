import { parseResultCompanyAssessment } from './company-assessment';
import { parseManufacturerContact } from './manufacturer-contact';
import type { CheckResult } from './types';
import { normalizeBarcode } from './barcode';

const key = (value?: string) => (value ?? '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();

/** An omitted optional field does not retract sourced research for the same saved product. */
export function retainPreviousResearch(result: CheckResult, previous: CheckResult): CheckResult {
  const identity = result.identity;
  const barcodeKey = (value?: string) => value?.trim() ? normalizeBarcode(value)?.padStart(14, '0') : '';
  const barcode = barcodeKey(identity.barcode), previousBarcode = barcodeKey(previous.identity.barcode);
  if (!identity.name?.trim() || !identity.brand?.trim() || !identity.market?.trim() ||
    (['name', 'brand', 'market'] as const).some(field => key(identity[field]) !== key(previous.identity[field])) ||
    barcode === undefined || previousBarcode === undefined || barcode !== previousBarcode) return result;
  const company = parseResultCompanyAssessment(previous.companyAssessment);
  const contact = parseManufacturerContact(previous.manufacturerContact);
  return {
    ...result,
    ...(!result.companyAssessment && company && key(company.brand) === key(identity.brand) ? { companyAssessment: company } : {}),
    ...(!result.manufacturerContact && ['uncertain', 'conflicting'].includes(result.outcome) && contact &&
      key(contact.brand) === key(identity.brand) && key(contact.productName) === key(identity.name) ? { manufacturerContact: contact } : {}),
  };
}
