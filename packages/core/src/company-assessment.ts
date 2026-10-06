import { safeContactUrl } from './manufacturer-contact';
import type { AICompanyAssessment, AIExtraction, CheckInput, CheckResult, CompanyAssessment, CompanyConcern } from './types';

const categories: CompanyConcern['category'][] = ['animal_testing', 'animal_welfare_lobbying', 'animal_exploitation'];
const key = (value?: string) => (value ?? '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, max: number): value is string => typeof value === 'string' && Boolean(value.trim()) && value.length <= max && !/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(value);

/** Optional company output must never invalidate a useful product assessment. */
export function parseCompanyAssessment(value: unknown): AICompanyAssessment | undefined {
  if (!object(value) || Object.keys(value).some(field => !['brand', 'company', 'scope', 'verdict', 'summary', 'categories', 'sources', 'ownershipSourceUrl'].includes(field)) ||
    !text(value.brand, 300) || !text(value.company, 300) || /[\n\t]/.test(value.brand + value.company) || !text(value.summary, 1500) ||
    value.scope !== 'direct' && value.scope !== 'parent' || !['concerns_found', 'no_concerns_found', 'inconclusive'].includes(String(value.verdict)) ||
    !Array.isArray(value.categories) || value.categories.length > 3 || new Set(value.categories).size !== value.categories.length ||
    value.categories.some(category => !categories.includes(category)) ||
    !Array.isArray(value.sources) || value.sources.length < 1 || value.sources.length > 5 ||
    value.sources.some(source => !object(source) || Object.keys(source).some(field => !['url', 'title', 'quote'].includes(field)) ||
      !safeContactUrl(source.url) || !text(source.title, 300) || !text(source.quote, 1000)) ||
    value.ownershipSourceUrl !== undefined && !safeContactUrl(value.ownershipSourceUrl) ||
    value.scope === 'parent' && value.ownershipSourceUrl === undefined ||
    value.verdict === 'concerns_found' && value.categories.length === 0 ||
    value.verdict === 'no_concerns_found' && value.categories.length !== 0) return;
  return structuredClone(value) as unknown as AICompanyAssessment;
}
function isoTimestamp(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return day >= 1 && day <= ([31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 0);
}
export function parseResultCompanyAssessment(value: unknown): CompanyAssessment | undefined {
  if (!object(value) || typeof value.assessedAt !== 'string' || !isoTimestamp(value.assessedAt)) return;
  const { assessedAt, ...fields } = value;
  const assessment = parseCompanyAssessment(fields);
  return assessment ? { ...assessment, assessedAt } : undefined;
}
/** A source URL is provenance, not proof that the model interpreted the page correctly. */
export function sourcedCompanyAssessment(extracted: AIExtraction): AICompanyAssessment | undefined {
  const assessment = parseCompanyAssessment(extracted.companyAssessment);
  if (!assessment || !key(extracted.brand) || key(assessment.brand) !== key(extracted.brand) || !extracted.research?.searched) return;
  const sources = new Set(extracted.research.sources.map(source => source.url));
  if (assessment.sources.some(source => !sources.has(source.url)) || assessment.ownershipSourceUrl && !sources.has(assessment.ownershipSourceUrl)) return;
  return assessment;
}
export function applyCompanyAssessment(result: CheckResult, input: CheckInput, extracted: AIExtraction): CheckResult {
  const { companyAssessment: _previous, ...withoutAssessment } = result;
  const assessment = sourcedCompanyAssessment(extracted);
  if (!assessment || key(result.identity.brand) !== key(assessment.brand) || input.brand && key(input.brand) !== key(assessment.brand)) return withoutAssessment;
  return { ...withoutAssessment, companyAssessment: { ...assessment, assessedAt: result.checkedAt } };
}
