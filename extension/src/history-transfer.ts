import { parseResultCompanyAssessment, type CheckResult, type CompanyConcern, type Evidence, type Finding } from '@vegsnap/core';
import type { HistoryResult } from './history';

export const HISTORY_IMPORT_MAX_BYTES = 5_000_000;
export const HISTORY_IMPORT_MAX_RESULTS = 1000;
const OUTCOMES = ['vegan', 'not_vegan', 'uncertain', 'conflicting'] as const;
const BASES = ['certified', 'manufacturer', 'research', 'composition', 'packaging', 'insufficient'] as const;
const CATEGORIES = ['food', 'drink', 'cosmetics', 'household', 'clothing', 'shoes', 'other'] as const;
const AI_STATUSES = ['not_needed', 'disabled', 'offline', 'unconfigured', 'vision_disabled', 'failed', 'text', 'images'] as const;
const WEB_STATUSES = ['searched', 'not_used', 'unsupported'] as const;
const MARKET_SOURCES = ['manual', 'fallback', 'packaging', 'database'] as const;
const MATCHES = ['exact_barcode', 'unconfirmed'] as const;
const FINDING_STATUSES = ['animal', 'plant', 'ambiguous', 'unknown'] as const;
const EVIDENCE_KINDS = ['user_text', 'database', 'ai_extraction', 'certification', 'manufacturer', 'ocr'] as const;
const CLAIMS = ['vegan', 'not_vegan'] as const;
const VERIFICATIONS = ['registry', 'packaging', 'source', 'unverified'] as const;
const CONCERN_CATEGORIES = ['animal_testing', 'animal_welfare_lobbying', 'animal_exploitation'] as const;
const CONCERN_STATUSES = ['current', 'resolved', 'disputed'] as const;
const SCOPES = ['direct', 'parent'] as const;
const LOCALES = ['en', 'de'] as const;
const LONG = 30_000;
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const unsupported = () => new Error('Unsupported history file.');
const invalid = () => new Error('Invalid history result.');
const identityKey = (value?: string) => (value ?? '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
function text(value: unknown, maximum: number, minimum = 0): string {
  if (typeof value !== 'string' || value.length < minimum || value.length > maximum) throw invalid();
  return value;
}
function optional<T>(value: unknown, parse: (value: unknown) => T): T | undefined { return value === undefined ? undefined : parse(value); }
function oneOf<T extends string>(value: unknown, values: readonly T[]): T {
  if (!values.includes(value as T)) throw invalid();
  return value as T;
}
const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
function timestamp(value: unknown): string {
  const time = text(value, 40);
  if (!ISO_DATE_TIME.test(time) || !Number.isFinite(Date.parse(time))) throw invalid();
  return time;
}
function link(value: unknown): string {
  const url = text(value, 2000);
  if (!/^https?:\/\//.test(url)) throw invalid();
  return url;
}
function texts(value: unknown, maximumItems: number): string[] {
  if (!Array.isArray(value) || value.length > maximumItems) throw invalid();
  return value.map(item => text(item, LONG));
}
function items<T>(value: unknown, maximumItems: number, parse: (item: Record<string, unknown>) => T): T[] {
  if (!Array.isArray(value) || value.length > maximumItems) throw invalid();
  return value.map(item => { if (!record(item)) throw invalid(); return parse(item); });
}
function defined<T extends object>(value: T): T { return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T; }
function finding(item: Record<string, unknown>): Finding {
  const parsed = defined({ term: text(item.term, LONG), displayTerm: optional(item.displayTerm, value => text(value, 300, 1)), displayLocale: optional(item.displayLocale, value => oneOf(value, LOCALES)),
    status: oneOf(item.status, FINDING_STATUSES), ruleId: optional(item.ruleId, value => text(value, 300)), explanation: text(item.explanation, LONG), evidenceId: text(item.evidenceId, LONG) });
  if ((parsed.displayTerm === undefined) !== (parsed.displayLocale === undefined) || parsed.displayTerm !== undefined && !parsed.displayTerm.trim()) throw invalid();
  return parsed;
}
function evidence(item: Record<string, unknown>): Evidence {
  return defined({ id: text(item.id, LONG), kind: oneOf(item.kind, EVIDENCE_KINDS), title: text(item.title, LONG), excerpt: text(item.excerpt, LONG), url: optional(item.url, link),
    retrievedAt: timestamp(item.retrievedAt), sourceDate: optional(item.sourceDate, timestamp), license: optional(item.license, value => text(value, 1000)),
    claim: optional(item.claim, value => oneOf(value, CLAIMS)), verification: optional(item.verification, value => oneOf(value, VERIFICATIONS)) });
}
function concern(item: Record<string, unknown>): CompanyConcern {
  return defined({ id: optional(item.id, value => text(value, 300)), company: text(item.company, LONG), category: oneOf(item.category, CONCERN_CATEGORIES), description: text(item.description, LONG),
    sourceUrl: link(item.sourceUrl), reviewedAt: timestamp(item.reviewedAt), status: oneOf(item.status, CONCERN_STATUSES), scope: optional(item.scope, value => oneOf(value, SCOPES)),
    matchedBrand: optional(item.matchedBrand, value => text(value, 300)), ownershipSourceUrl: optional(item.ownershipSourceUrl, link),
    ownershipReviewedAt: optional(item.ownershipReviewedAt, timestamp), sourceDate: optional(item.sourceDate, value => text(value, 40)) });
}
function identity(value: unknown): CheckResult['identity'] {
  if (!record(value)) throw invalid();
  return defined({ name: optional(value.name, item => text(item, 500)), brand: optional(value.brand, item => text(item, 300)),
    barcode: optional(value.barcode, item => { const code = text(item, 14); if (!/^(?:[0-9]{8}|[0-9]{12}|[0-9]{13}|[0-9]{14})$/.test(code)) throw invalid(); return code; }),
    market: text(value.market, 10, 1), marketSource: optional(value.marketSource, item => oneOf(item, MARKET_SOURCES)), match: oneOf(value.match, MATCHES) });
}
/** Only the public analysis fields transfer. Provider error copy and contact details never do; drafts and photos stay on their device. */
function result(item: Record<string, unknown>, assessmentNotice: string, knownNotices: ReadonlySet<string>): HistoryResult {
  if (item.schemaVersion !== 1 || typeof item.usedAI !== 'boolean') throw invalid();
  const parsed: HistoryResult = defined({ schemaVersion: 1, id: text(item.id, 100, 1), outcome: oneOf(item.outcome, OUTCOMES), basis: oneOf(item.basis, BASES), title: text(item.title, 500),
    summary: text(item.summary, LONG), category: oneOf(item.category, CATEGORIES), identity: identity(item.identity), findings: items(item.findings, 1000, finding),
    evidence: items(item.evidence, 1000, evidence), questions: texts(item.questions, 100), warnings: texts(item.warnings, 100), crossContact: texts(item.crossContact, 100),
    companyConcerns: items(item.companyConcerns, 1000, concern), checkedAt: timestamp(item.checkedAt), usedAI: item.usedAI,
    aiStatus: optional(item.aiStatus, value => oneOf(value, AI_STATUSES)), webSearchStatus: optional(item.webSearchStatus, value => oneOf(value, WEB_STATUSES)) });
  // A notice from an earlier import, in any language, only stays when this import keeps an assessment.
  parsed.warnings = parsed.warnings.filter(warning => !knownNotices.has(warning));
  const assessment = item.companyAssessment === undefined ? undefined : parseResultCompanyAssessment(item.companyAssessment);
  if (assessment && identityKey(assessment.brand) === identityKey(parsed.identity.brand)) {
    parsed.companyAssessment = assessment;
    parsed.warnings = [...parsed.warnings.slice(0, 99), assessmentNotice];
  }
  return parsed;
}
/** `knownNotices` lists the imported-assessment notice in every language a transferred file may carry. */
export function parseHistoryImport(content: string, assessmentNotice: string, knownNotices: readonly string[] = [assessmentNotice]): HistoryResult[] {
  if (new TextEncoder().encode(content).length > HISTORY_IMPORT_MAX_BYTES) throw new Error('History files must be smaller than 5 MB.');
  let document: unknown;
  try { document = JSON.parse(content); } catch { throw unsupported(); }
  if (!record(document) || document.schemaVersion !== 1 || !Array.isArray(document.results) || document.results.length > HISTORY_IMPORT_MAX_RESULTS) throw unsupported();
  const results = new Map<string, HistoryResult>();
  const notices = new Set([assessmentNotice, ...knownNotices]);
  for (const item of document.results) {
    if (!record(item)) throw invalid();
    const parsed = result(item, assessmentNotice, notices);
    if (!results.has(parsed.id)) results.set(parsed.id, parsed);
  }
  return [...results.values()];
}
/** Saved checks keep priority over a transferred copy with the same identifier. */
export function mergeHistoryImport(existing: readonly HistoryResult[], imported: readonly HistoryResult[]): { added: HistoryResult[]; skipped: number } {
  const ids = new Set(existing.map(item => item.id));
  const added = imported.filter(item => !ids.has(item.id));
  return { added, skipped: imported.length - added.length };
}
