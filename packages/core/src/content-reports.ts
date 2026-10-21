import { SubmissionError } from './community';
import type { CheckResult, Finding, Outcome } from './types';

export type ReportKind = 'ai' | 'community' | 'result';
export type ReportPlatform = 'android' | 'ios' | 'extension';
export interface ResultReportFinding { term: string; status: Finding['status']; ruleId: string; }
/** Verdict context for a wrong-result report: never photos, evidence text, history or credentials. */
export interface ResultReport {
  product: string;
  brand: string;
  outcome: Outcome;
  findings: ResultReportFinding[];
  locale: string;
  platform: ReportPlatform;
  appVersion: string;
}
export interface ContentReport { kind: ReportKind; contentId: string; text: string; reason: string; result?: ResultReport; }
export const REPORT_LIMITS = { reason: 2000, text: 8000, product: 300, findings: 200, term: 200, ruleId: 100, appVersion: 40 } as const;
const REPORT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const OUTCOMES: Outcome[] = ['vegan', 'not_vegan', 'uncertain', 'conflicting'];
const STATUSES: Finding['status'][] = ['animal', 'plant', 'ambiguous', 'unknown'];
const PLATFORMS: ReportPlatform[] = ['android', 'ios', 'extension'];
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
/** Database and AI values can carry control characters; the projection drops them so the report stays sendable. */
const clean = (value: string, limit: number) => value.replace(new RegExp(CONTROL.source, 'g'), '').trim().slice(0, limit);

/** Android mirrors this in ContentReports.kt; iOS calls it through the bridge. Keep the field set identical. */
export function resultReport(result: Pick<CheckResult, 'identity' | 'outcome' | 'findings'>, client: { locale: string; platform: ReportPlatform; appVersion: string }): ResultReport {
  return {
    product: clean(result.identity.name ?? '', REPORT_LIMITS.product),
    brand: clean(result.identity.brand ?? '', REPORT_LIMITS.product),
    outcome: result.outcome,
    findings: result.findings.slice(0, REPORT_LIMITS.findings)
      .map(finding => ({ term: clean(finding.term, REPORT_LIMITS.term), status: finding.status, ruleId: clean(finding.ruleId ?? '', REPORT_LIMITS.ruleId) }))
      .filter(finding => finding.term),
    locale: clean(client.locale, 10),
    platform: client.platform,
    appVersion: clean(client.appVersion, REPORT_LIMITS.appVersion),
  };
}

function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function text(value: unknown, limit: number): string | undefined {
  return typeof value === 'string' && value.length <= limit && !CONTROL.test(value) ? value : undefined;
}
function validateResultReport(value: unknown): ResultReport {
  const invalid = (message: string) => new SubmissionError('result', message);
  if (!record(value) || Object.keys(value).some(key => !['product', 'brand', 'outcome', 'findings', 'locale', 'platform', 'appVersion'].includes(key))) throw invalid('Unexpected result fields.');
  const product = text(value.product ?? '', REPORT_LIMITS.product), brand = text(value.brand ?? '', REPORT_LIMITS.product);
  const locale = typeof value.locale === 'string' && /^[a-zA-Z]{2,8}(-[a-zA-Z0-9]{2,8})?$/.test(value.locale) ? value.locale : undefined;
  const appVersion = text(value.appVersion ?? '', REPORT_LIMITS.appVersion);
  if (product === undefined || brand === undefined || locale === undefined || appVersion === undefined ||
      !OUTCOMES.includes(value.outcome as Outcome) || !PLATFORMS.includes(value.platform as ReportPlatform)) throw invalid('Check the reported result details.');
  if (!Array.isArray(value.findings) || value.findings.length > REPORT_LIMITS.findings) throw invalid('Too many reported ingredients.');
  const findings = value.findings.map((finding: unknown): ResultReportFinding => {
    if (!record(finding) || Object.keys(finding).some(key => !['term', 'status', 'ruleId'].includes(key))) throw invalid('Unexpected ingredient fields.');
    const term = text(finding.term, REPORT_LIMITS.term), ruleId = text(finding.ruleId ?? '', REPORT_LIMITS.ruleId);
    if (!term?.trim() || ruleId === undefined || !STATUSES.includes(finding.status as Finding['status'])) throw invalid('Check the reported ingredients.');
    return { term, status: finding.status as Finding['status'], ruleId };
  });
  return { product: product.trim(), brand: brand.trim(), outcome: value.outcome as Outcome, findings, locale, platform: value.platform as ReportPlatform, appVersion };
}
/** Shared by the Worker and the extension so a report is rejected before it leaves the device when it would be refused. */
export function validateContentReport(value: unknown): ContentReport {
  if (!record(value) || Object.keys(value).some(key => !['kind', 'contentId', 'text', 'reason', 'result'].includes(key))) throw new SubmissionError('report', 'Unexpected report fields.');
  const { kind, contentId, text: body, reason, result } = value;
  if (kind !== 'ai' && kind !== 'community' && kind !== 'result' || typeof contentId !== 'string' || typeof body !== 'string' ||
      typeof reason !== 'string' || !reason.trim() || reason.length > REPORT_LIMITS.reason || body.length > REPORT_LIMITS.text ||
      CONTROL.test(reason) || CONTROL.test(body)) throw new SubmissionError('reason', 'Check the report text and reason.');
  if (kind !== 'result' && result !== undefined) throw new SubmissionError('result', 'Unexpected report fields.');
  if (kind === 'ai' && (contentId !== '' || !body.trim())) throw new SubmissionError('text', 'Include the AI text you want to report.');
  if (kind === 'community' && (!REPORT_ID.test(contentId) || body !== '')) throw new SubmissionError('contentId', 'Invalid community reply reference.');
  if (kind === 'result' && (contentId !== '' || body !== '')) throw new SubmissionError('result', 'Include the result you want to report.');
  const report: ContentReport = { kind, contentId, text: body.trim(), reason: reason.trim() };
  if (kind === 'result') report.result = validateResultReport(result);
  return report;
}
