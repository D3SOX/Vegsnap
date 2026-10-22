import { browser } from 'wxt/browser';

const REPLY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** Anonymous reviewed replies have no contributor profiles; users block individual records on this device. */
export async function hiddenReplies(): Promise<string[]> {
  const value: unknown = (await browser.storage.local.get('hiddenReplies')).hiddenReplies;
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string' && REPLY_ID.test(id)) : [];
}
export async function hideReply(id: string): Promise<void> {
  if (!REPLY_ID.test(id)) throw new Error('Invalid reply reference.');
  const current = await hiddenReplies();
  if (!current.includes(id)) await browser.storage.local.set({ hiddenReplies: [...current, id] });
}
export async function restoreReplies(): Promise<void> { await browser.storage.local.remove('hiddenReplies'); }
