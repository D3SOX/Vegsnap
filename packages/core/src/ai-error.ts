import { resultMessages } from './i18n';
import { readBoundedText } from './http';
import type { AIErrorCode, Locale } from './types';

type ResultMessage = keyof typeof resultMessages.en;
/**
 * A classified AI failure. The English message is for logs and tests; users see the localized copy for its code,
 * or `display`: fixed, actionable copy from trusted local code such as the desktop companion, never provider text.
 */
export class AIFailure extends Error {
  constructor(readonly code: AIErrorCode, message: string, readonly messageKey?: ResultMessage, readonly display?: string) { super(message); }
}

const messageKeys: Record<AIErrorCode, ResultMessage> = {
  authentication: 'aiAuthenticationError', access_denied: 'aiAccessError', quota: 'aiQuotaError', rate_limit: 'aiRateLimitError',
  timeout: 'aiTimeoutError', network: 'aiNetworkError', unsupported_model: 'aiModelError', invalid_response: 'aiResponseError',
  incomplete_response: 'aiIncompleteError', request_rejected: 'aiRequestError', service: 'aiServiceError', unknown: 'aiUnknownError',
};
const envelopeCodes: [AIErrorCode, string[]][] = [
  ['authentication', ['invalid_api_key', 'invalid_token', 'expired_token', 'invalid_grant', 'token_expired', 'authentication_error']],
  ['quota', ['insufficient_quota', 'usage_limit_reached', 'quota_exceeded', 'credit_balance_too_low', 'plan_limit_exceeded', 'subscription_sharing_usage_limit_exceeded']],
  ['rate_limit', ['rate_limit_exceeded', 'rate_limit_error']],
  ['unsupported_model', ['model_not_found', 'model_not_supported', 'unsupported_model', 'unsupported_image', 'unsupported_content_type', 'unsupported_capability', 'subscription_sharing_unsupported_capability']],
  ['access_denied', ['permission_denied', 'permission_error', 'access_denied', 'user_not_eligible', 'subscription_sharing_user_not_eligible']],
  ['service', ['server_error', 'internal_server_error', 'overloaded_error', 'subscription_sharing_usage_unavailable']],
  ['timeout', ['timeout', 'request_timeout']],
];

/** Same classification as Android: a known provider error code wins over the HTTP status. The body is never kept. */
export async function httpFailure(response: Response, service: string): Promise<AIFailure> {
  let envelope: unknown;
  try { envelope = JSON.parse(await readBoundedText(response, 65_536)); } catch { envelope = undefined; }
  const record = (value: unknown) => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  const outer = record(envelope);
  const error = record(outer?.error) ?? outer;
  const codes = [error?.code, error?.type, outer?.error].filter((value): value is string => typeof value === 'string').map(value => value.toLowerCase());
  const status = response.status;
  const code = envelopeCodes.find(([, values]) => codes.some(value => values.includes(value)))?.[0] ??
    (status === 401 ? 'authentication' : status === 403 ? 'access_denied' : status === 408 || status === 504 ? 'timeout' :
      status === 429 ? 'rate_limit' : status >= 500 ? 'service' : 'request_rejected');
  return new AIFailure(code, `${service} returned HTTP ${status}.`);
}

export function aiErrorCode(error: unknown): AIErrorCode {
  if (error instanceof AIFailure) return error.code;
  // JavaScriptCore (the iOS bridge) has no DOMException, so match the name only.
  if ((error as { name?: unknown } | null)?.name === 'TimeoutError') return 'timeout';
  if (error instanceof TypeError) return 'network';
  if (error instanceof SyntaxError) return 'invalid_response';
  return 'unknown';
}
/** Fixed localized copy for a failed AI check; never a raw provider error. */
export function aiError(error: unknown, locale: Locale = 'en', hosted = false): { code: AIErrorCode; message: string } {
  const t = resultMessages[locale];
  const code = aiErrorCode(error);
  if (error instanceof AIFailure && error.display) return { code, message: error.display };
  const key = error instanceof AIFailure && error.messageKey ? error.messageKey
    : hosted && code === 'quota' ? 'hostedQuotaError' : hosted && code === 'rate_limit' ? 'hostedRateLimitError' : messageKeys[code];
  return { code, message: t[key] };
}
