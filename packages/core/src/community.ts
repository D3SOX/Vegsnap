import { resultMessages } from './i18n';
import service from '../../../data/community-service.json';
import { normalizeBarcode } from './barcode';
import { safeContactUrl } from './manufacturer-contact';
import type { CheckResult } from './types';

export type ReplyClaim = 'vegan' | 'not_vegan' | 'inconclusive';
export type ReplyScope = 'whole_product' | 'ingredients' | 'processing';
export interface CommunityProduct {
  productName: string;
  brand: string;
  barcode: string;
  variant: string;
}
export interface ReplyCoverage {
  type: 'products' | 'range';
  markets: string[];
  products: CommunityProduct[];
  range?: { name: string; wholeBrand: boolean; brandAliases: string[]; namePrefixes: string[] };
}
export interface CommunitySubmission {
  productName: string;
  brand: string;
  barcode: string;
  market: string;
  variant: string;
  question: string;
  reply: string;
  repliedOn: string;
  claim: ReplyClaim;
  scope: ReplyScope;
  sourceUrl: string;
  coverage?: ReplyCoverage;
}
export interface CommunityReply extends CommunitySubmission {
  id: string;
  reviewedAt: string;
  evidencePublic: boolean;
  match?: 'barcode' | 'name' | 'brand' | 'candidate';
}
export class SubmissionError extends Error {
  constructor(public readonly field: string, message: string) { super(message); }
}
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function text(value: Record<string, unknown>, field: string, limit: number, required = true): string {
  const item = value[field] ?? '';
  if (typeof item !== 'string' || item.length > limit || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(item)) throw new SubmissionError(field, `Enter valid text of at most ${limit} characters.`);
  const trimmed = item.trim();
  if (required && !trimmed) throw new SubmissionError(field, 'This field is required.');
  return trimmed;
}
/** Unreviewed community content remains separate from product evaluation and saved history. */
export function validateCommunitySubmission(value: unknown, now = new Date()): CommunitySubmission {
  if (!record(value)) throw new SubmissionError('form', 'Invalid submission.');
  const productName = text(value, 'productName', 300);
  const brand = text(value, 'brand', 300);
  const rawBarcode = text(value, 'barcode', 40, false);
  const barcode = rawBarcode ? normalizeBarcode(rawBarcode)?.padStart(14, '0') : '';
  if (barcode === undefined) throw new SubmissionError('barcode', 'Check the barcode digits and checksum.');
  const market = text(value, 'market', 2).toUpperCase();
  if (!/^[A-Z]{2}$/.test(market)) throw new SubmissionError('market', 'Use a two-letter country code, such as DE or SE.');
  const variant = text(value, 'variant', 300, false);
  const question = text(value, 'question', 4000);
  const reply = text(value, 'reply', 8000);
  const repliedOn = text(value, 'repliedOn', 10);
  const date = new Date(`${repliedOn}T00:00:00Z`);
  if (!/^\d{4}-\d\d-\d\d$/.test(repliedOn) || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== repliedOn || repliedOn > now.toISOString().slice(0, 10)) throw new SubmissionError('repliedOn', 'Enter the actual response date, no later than today.');
  const claim = value.claim;
  if (claim !== 'vegan' && claim !== 'not_vegan' && claim !== 'inconclusive') throw new SubmissionError('claim', 'Select what the manufacturer confirmed.');
  const scope = value.scope;
  if (scope !== 'whole_product' && scope !== 'ingredients' && scope !== 'processing') throw new SubmissionError('scope', 'Select what the response covers.');
  const sourceUrl = text(value, 'sourceUrl', 2000, false);
  if (sourceUrl && !safeContactUrl(sourceUrl)) throw new SubmissionError('sourceUrl', 'Use a public HTTPS source URL.');
  const submission: CommunitySubmission = { productName, brand, barcode, market, variant, question, reply, repliedOn, claim, scope, sourceUrl };
  if (value.coverage !== undefined) {
    try { submission.coverage = validateCoverage(value.coverage, market); }
    catch (error) { if (error instanceof SubmissionError) throw new SubmissionError('coverage', error.message); throw error; }
  }
  return submission;
}
export const communityIdentityKey = (value: string) => value.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
/** Fragment prefill sends only chosen product identity; the host does not receive it in the initial request. */
export function communityLinks(result: Pick<CheckResult, 'identity'>, language: string, baseUrl = service.baseUrl): { submit: string; replies: string } | undefined {
  if (!safeContactUrl(baseUrl)) return;
  const params = new URLSearchParams();
  for (const [key, limit] of [['name', 300], ['brand', 300], ['barcode', 40], ['market', 2]] as const) {
    const value = result.identity[key];
    if (value) params.set(key, value.slice(0, limit));
  }
  params.set('lang', ['en', 'de', 'sv'].includes(language) ? language : 'en');
  const origin = new URL(baseUrl).origin;
  return { submit: `${origin}/submit#${params}`, replies: `${origin}/replies#${params}` };
}

function stringList(value: unknown, field: string, limit: number, length: number): string[] {
  if (!Array.isArray(value) || value.length > limit || value.some(item => typeof item !== 'string' || !item.trim() || item.length > length || /[\u0000-\u001F\u007F]/.test(item)))
    throw new SubmissionError('coverage', `Check ${field} (at most ${limit} entries).`);
  return [...new Set(value.map(item => item.trim()))];
}
function validateCoverage(value: unknown, market: string): ReplyCoverage {
  if (!record(value) || !['products', 'range'].includes(String(value.type))) throw new SubmissionError('coverage', 'Choose products or a product range.');
  const markets = stringList(value.markets, 'countries', 10, 2).map(item => item.toUpperCase());
  if (!markets.length || !markets.includes(market) || markets.some(item => !/^[A-Z]{2}$/.test(item))) throw new SubmissionError('coverage', 'Use country codes and include the primary country.');
  if (!Array.isArray(value.products) || value.products.length > 25) throw new SubmissionError('coverage', 'Enter at most 25 products.');
  const products = value.products.map((product: unknown): CommunityProduct => {
    if (!record(product)) throw new SubmissionError('coverage', 'Check the product details.');
    const raw = text(product, 'barcode', 40, false);
    const barcode = raw ? normalizeBarcode(raw)?.padStart(14, '0') : '';
    if (barcode === undefined) throw new SubmissionError('coverage', 'Check each product barcode and checksum.');
    return { productName: text(product, 'productName', 300), brand: text(product, 'brand', 300), barcode, variant: text(product, 'variant', 300, false) };
  });
  const coverage: ReplyCoverage = { type: value.type as ReplyCoverage['type'], markets: [...new Set(markets)], products };
  if (coverage.type === 'products' && !products.length) throw new SubmissionError('coverage', 'Add at least one product.');
  if (coverage.type === 'range') {
    if (!record(value.range) || typeof value.range.wholeBrand !== 'boolean') throw new SubmissionError('coverage', 'Describe the product range.');
    const range = { name: text(value.range, 'name', 300), wholeBrand: value.range.wholeBrand,
      brandAliases: stringList(value.range.brandAliases, 'brand aliases', 10, 300), namePrefixes: stringList(value.range.namePrefixes, 'product name prefixes', 10, 300) };
    if (range.wholeBrand && !range.brandAliases.length) throw new SubmissionError('coverage', 'Whole-brand coverage needs an exact brand alias.');
    if (!products.length && !range.brandAliases.length && !range.namePrefixes.length) throw new SubmissionError('coverage', 'Add a product, brand alias or product name prefix for the range.');
    coverage.range = range;
  }
  return coverage;
}
export function replyCoverage(submission: CommunitySubmission): ReplyCoverage {
  return submission.coverage ?? { type: 'products', markets: [submission.market], products: [{ productName: submission.productName,
    brand: submission.brand, barcode: submission.barcode, variant: submission.variant }] };
}
export interface CommunityMatchRule { market: string; kind: 'barcode' | 'name' | 'brand' | 'brand_candidate' | 'prefix'; key: string; barcode: string; }
export function communityMatchRules(submission: CommunitySubmission): CommunityMatchRule[] {
  const coverage = replyCoverage(submission), rules: CommunityMatchRule[] = [];
  for (const market of coverage.markets) {
    for (const product of coverage.products) {
      if (product.barcode) rules.push({ market, kind: 'barcode', key: product.barcode, barcode: product.barcode });
      rules.push({ market, kind: 'name', key: JSON.stringify([communityIdentityKey(product.productName), communityIdentityKey(product.brand)]), barcode: product.barcode });
    }
    if (coverage.type === 'range' && coverage.range) {
      for (const alias of coverage.range.brandAliases) rules.push({ market, kind: coverage.range.wholeBrand ? 'brand' : 'brand_candidate', key: communityIdentityKey(alias), barcode: '' });
      for (const prefix of coverage.range.namePrefixes) rules.push({ market, kind: 'prefix', key: communityIdentityKey(prefix), barcode: '' });
    }
  }
  return rules;
}

/** Apply only current, matched and reviewed whole-product claims to a display copy. */
export function applyCommunityReplies(result: CheckResult, replies: CommunityReply[], locale: string, baseUrl = service.baseUrl, now = new Date()): CheckResult {
  const eligible = replies.filter(reply => reply.scope === 'whole_product' && reply.claim !== 'inconclusive' && reply.match !== 'candidate');
  if (!eligible.length) return result;
  const de = locale === 'de';
  const t = resultMessages[de ? 'de' : 'en'];
  const positive = eligible.some(reply => reply.claim === 'vegan'), negative = eligible.some(reply => reply.claim === 'not_vegan');
  const conflict = result.outcome === 'conflicting' || positive && (negative || result.outcome === 'not_vegan' || result.findings.some(item => item.status === 'animal')) || negative && result.outcome === 'vegan';
  const links = communityLinks(result, locale, baseUrl);
  return { ...result, outcome: conflict ? 'conflicting' : positive ? 'vegan' : 'not_vegan', basis: conflict ? 'insufficient' : 'manufacturer',
    title: conflict ? t.conflictingEvidence : positive ? t.manufacturerSaysVegan : t.manufacturerSaysNotVegan,
    summary: conflict ? t.communityConflictSummary : t.communityConfirmationSummary,
    questions: conflict ? result.questions : [],
    evidence: [...result.evidence, ...eligible.map(reply => ({ id: `community-${reply.id}`, kind: 'manufacturer' as const,
      title: `${t.reviewedManufacturerReply}: ${reply.brand}`, excerpt: reply.reply,
      ...(links ? { url: links.replies } : {}), retrievedAt: now.toISOString(), sourceDate: `${reply.repliedOn}T00:00:00Z`, claim: reply.claim as 'vegan' | 'not_vegan', verification: 'unverified' as const }))],
    warnings: [...result.warnings, t.communityReplyCaution],
  };
}

export interface CommunityReplyPage { replies: CommunityReply[]; candidates: CommunityReply[]; more: boolean; }
/** Lookup identity only; never include findings, photos, history or provider credentials. */
export function communityLookupParams(identity: CheckResult['identity']): URLSearchParams {
  const market = identity.market.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(market)) throw new SubmissionError('market', 'Enter a two-letter country code.');
  const barcode = identity.barcode ? normalizeBarcode(identity.barcode)?.padStart(14, '0') : '';
  if (barcode === undefined) throw new SubmissionError('barcode', 'Check the product barcode.');
  const name = identity.name?.trim().slice(0,300) ?? '', brand = identity.brand?.trim().slice(0,300) ?? '';
  if (!barcode && (!name || !brand)) throw new SubmissionError('name', 'Enter a product name and brand, or a barcode.');
  return new URLSearchParams({ market, ...(barcode ? { barcode } : {}), ...(name ? { name } : {}), ...(brand ? { brand } : {}) });
}
export function parseCommunityReplyPage(value: unknown): CommunityReplyPage {
  if (!record(value) || !Array.isArray(value.replies) || value.replies.length > 50 || typeof value.more !== 'boolean' ||
    value.candidates !== undefined && (!Array.isArray(value.candidates) || value.candidates.length > 50)) throw new Error('Invalid community response.');
  function parse(items: unknown[], candidate: boolean): CommunityReply[] {
    return items.map(item => {
      if (!record(item) || typeof item.id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(item.id) ||
        typeof item.reviewedAt !== 'string' || !Number.isFinite(Date.parse(item.reviewedAt)) || typeof item.evidencePublic !== 'boolean' ||
        item.match !== undefined && !['barcode','name','brand','candidate'].includes(String(item.match)) || !candidate && item.match === 'candidate') throw new Error('Invalid reviewed reply.');
      return { ...validateCommunitySubmission(item), id: item.id, reviewedAt: item.reviewedAt, evidencePublic: item.evidencePublic,
        ...(candidate ? { match: 'candidate' as const } : item.match ? { match: item.match as CommunityReply['match'] } : {}) };
    });
  }
  return { replies: parse(value.replies, false), candidates: parse((value.candidates ?? []) as unknown[], true), more: value.more };
}
