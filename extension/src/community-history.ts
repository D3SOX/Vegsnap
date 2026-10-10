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
