import { applyCommunityReplies, type CheckResult, type CommunityReply, type Locale } from '@vegsnap/core';
import type { HistoryResult } from './history';

export type CommunityOriginal = Pick<CheckResult, 'outcome' | 'basis' | 'title' | 'summary' | 'questions' | 'evidence' | 'warnings'>;

export function withoutCommunityHistory(result: HistoryResult): HistoryResult {
  const { communityOriginal, ...original } = result;
  return communityOriginal ? { ...original, ...communityOriginal } : result;
}

export function applyCommunityHistory(result: HistoryResult, replies: CommunityReply[], locale: Locale, now: Date): HistoryResult {
  const original = withoutCommunityHistory(result);
  const updated = applyCommunityReplies(original, replies, locale, undefined, now);
  if (updated === original) return original;
  const { outcome, basis, title, summary, questions, evidence, warnings } = original;
  return { ...original, ...updated, communityOriginal: { outcome, basis, title, summary, questions, evidence, warnings } };
}
/** A cached community verdict that relies on a reply hidden on this device falls back to the original analysis. */
export function hidesCommunityHistory(result: HistoryResult, hidden: string[]): boolean {
  return !!result.communityOriginal && result.evidence.some(item => item.id.startsWith('community-') && hidden.includes(item.id.slice('community-'.length)));
}
