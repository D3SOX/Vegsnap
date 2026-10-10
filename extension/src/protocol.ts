import type { CheckInput, CheckStage, OfflinePackInfo } from '@vegsnap/core';
import { countryCode } from '@vegsnap/core';
import type { HistoryResult } from './history';
import type { Settings } from './settings';
import type { AccountOptions, CompanionCommand } from './companion-state';
import { validGtin } from './extraction';
export function scanInput(input: { text: string; category: CheckInput['category']; complete: boolean; images: string[]; market?: string; autoMarket?: boolean }): CheckInput {
  return { ...input, barcode: input.text.split(/\s+/).map(validGtin).find(Boolean), complete: input.complete ? true : undefined };
}
/** Page titles and structured product names provide identity, not ingredients. Selected text remains user composition. */
export function inspectedInput(page: { selection: string; title: string; products: { name?: string; barcode?: string }[] }): Pick<CheckInput, 'text' | 'name' | 'barcode'> {
  if (page.selection.trim()) return { text: page.selection };
  const product = page.products.length === 1 ? page.products[0] : undefined;
  return { text: '', name: product?.name || page.title, ...(product?.barcode ? { barcode: product.barcode } : {}) };
}
export type Request =
  | { type: 'state' }
  | { type: 'import-offline-pack'; text: string }
  | { type: 'remove-offline-pack'; region: string }
  | { type: 'set-language'; language: Settings['language'] }
  | { type: 'set-chatgpt-model'; model: string }
  | { type: 'update-settings'; patch: Partial<Settings> }
  | { type: 'set-api-token'; endpoint: string; token: string }
  | { type: 'set-store'; store: string; enabled: boolean }
  | { type: 'check'; input: CheckInput; requestId?: string }
  | { type: 'background-check'; barcode: string }
  | { type: 'open-check'; barcode?: string; name?: string; brand?: string; sourceUrl?: string }
  | { type: 'pending'; id: string }
  | { type: 'delete'; id?: string }
  | { type: 'set-result-market'; id: string; market: string }
  | { type: 'cache-community-result'; expected: string; result: HistoryResult }
  | { type: 'hosted'; command: 'connect' | 'status' | 'disconnect' }
  | ({ type: 'companion'; command: CompanionCommand } & AccountOptions);
export interface CheckProgressMessage { type: 'check-progress'; requestId: string; stage: CheckStage; }
export interface CheckReply extends HistoryResult { onlineConsent?: 'database' | 'ai'; }
export interface Pending { text?: string; imageUrl?: string; barcode?: string; name?: string; brand?: string; sourceUrl?: string; market?: string; createdAt: number; }
export function pendingInput(pending: Pending): CheckInput {
  return { ...scanInput({ text: pending.text ?? '', category: 'other', complete: false, images: [] }),
    ...(pending.barcode ? { barcode: pending.barcode } : {}), name: pending.name, brand: pending.brand, sourceUrl: pending.sourceUrl, market: pending.market };
}
export interface State { settings: Settings; history: HistoryResult[]; hasKey: boolean; offlinePacks: OfflinePackInfo[]; }
export type Reply<T> = { ok: true; result: T } | { ok: false; error: string };
export function isRecord(v: unknown): v is Record<string, unknown> { return v !== null && typeof v === 'object' && !Array.isArray(v); }
export function isBackgroundRequest(value: unknown): value is Extract<Request, { type: 'background-check' | 'open-check' }> {
  if (!isRecord(value)) return false;
  if (value.type === 'background-check') return validGtin(value.barcode) !== undefined;
  return value.type === 'open-check' &&
    (value.barcode === undefined || validGtin(value.barcode) !== undefined) &&
    (value.name === undefined || typeof value.name === 'string' && value.name.trim().length > 0 && value.name.length <= 500) &&
    (value.brand === undefined || typeof value.brand === 'string' && value.brand.length <= 300) &&
    (value.sourceUrl === undefined || typeof value.sourceUrl === 'string' && value.sourceUrl.length <= 2000) &&
    (validGtin(value.barcode) !== undefined || typeof value.name === 'string' && typeof value.sourceUrl === 'string');
}
export function isCheckInput(v: unknown): v is CheckInput {
  if (!isRecord(v)) return false;
  if (v.autoMarket !== undefined && typeof v.autoMarket !== 'boolean') return false;
  const strings = ['text', 'barcode', 'name', 'brand', 'market', 'sourceUrl'];
  if (!strings.every(key => v[key] === undefined || (typeof v[key] === 'string' && v[key].length <= 30_000))) return false;
  if (v.market !== undefined && (typeof v.market !== 'string' || !/^[A-Z]{2}$/.test(v.market) || !countryCode(v.market))) return false;
  if (v.category !== undefined && !['food', 'drink', 'cosmetics', 'household', 'clothing', 'shoes', 'other'].includes(String(v.category))) return false;
  if (v.locale !== undefined && !['en', 'de'].includes(String(v.locale))) return false;
  if (v.complete !== undefined && typeof v.complete !== 'boolean') return false;
  return v.images === undefined || (Array.isArray(v.images) && v.images.length <= 3 && v.images.every(x => typeof x === 'string' && x.length < 4_000_000 && /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(x)));
}
export function allowBackground(senderUrl: string | undefined, origins: readonly string[]): boolean {
  if (!senderUrl) return false;
  try {
    const url = new URL(senderUrl);
    if (url.protocol !== 'https:' || url.port || url.username || url.password) return false;
    return origins.some(origin => {
      const match = /^https:\/\/(\*\.)?([^/]+)\/\*$/.exec(origin);
      if (!match) return false;
      return url.hostname === match[2] || !!match[1] && url.hostname.endsWith(`.${match[2]}`);
    });
  } catch { return false; }
}
