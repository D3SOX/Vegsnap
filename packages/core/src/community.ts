import service from '../../../data/community-service.json';
import { normalizeBarcode } from './barcode';
import { safeContactUrl } from './manufacturer-contact';
import type { CheckResult } from './types';

export type ReplyClaim = 'vegan' | 'not_vegan' | 'inconclusive';
export type ReplyScope = 'whole_product' | 'ingredients' | 'processing';
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
}
export interface CommunityReply extends CommunitySubmission {
  id: string;
  reviewedAt: string;
  evidencePublic: boolean;
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
  return { productName, brand, barcode, market, variant, question, reply, repliedOn, claim, scope, sourceUrl };
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
