import { browser } from 'wxt/browser';
import { companion } from './companion';
import { isRecord } from './protocol';

export type CompanionCommand = 'status' | 'signIn' | 'models' | 'disconnect' | 'removeAccount';
export interface SavedAccount { id: string; email?: string; }
export interface AccountOptions { accountId?: string; newAccount?: boolean; }
export function accountDetails(value: Record<string, unknown>): { savedAccounts?: SavedAccount[]; selectedAccount?: string } {
  if (!Array.isArray(value.savedAccounts)) return {};
  const seen = new Set<string>();
  const savedAccounts: SavedAccount[] = [];
  for (const item of value.savedAccounts) {
    if (!isRecord(item) || typeof item.id !== 'string' || !item.id.length || item.id.length > 1000 || /[\u0000-\u001f\u007f]/.test(item.id) || seen.has(item.id)) continue;
    seen.add(item.id);
    savedAccounts.push({ id: item.id, ...(typeof item.email === 'string' && item.email.length <= 320 && !/[\u0000-\u001f\u007f]/.test(item.email) ? { email: item.email } : {}) });
  }
  return { savedAccounts, ...(typeof value.selectedAccount === 'string' && savedAccounts.some(account => account.id === value.selectedAccount) ? { selectedAccount: value.selectedAccount } : {}) };
}
export interface CompanionSnapshot {
  state: 'checking' | 'signedout' | 'connected' | 'unavailable';
  email?: string;
  savedAccounts?: SavedAccount[];
  selectedAccount?: string;
  task: '' | CompanionCommand;
  error?: string;
}

/** One background controller owns connection operations for every extension window. */
export function createCompanionState() {
  let queue = Promise.resolve();
  const pending = new Map<string, Promise<unknown>>();
  let accountIntent: string | undefined;
  let generation = 0;
  let freshUntil = 0;
  const save = (snapshot: CompanionSnapshot) => browser.storage.session.set({ chatGPTConnection: snapshot });
  async function snapshot(): Promise<CompanionSnapshot> {
    const value: unknown = (await browser.storage.session.get('chatGPTConnection')).chatGPTConnection;
    if (!isRecord(value) || !['checking', 'signedout', 'connected', 'unavailable'].includes(String(value.state))) return { state: 'checking', task: '' };
    return { state: value.state as CompanionSnapshot['state'], task: '', ...accountDetails(value), ...(typeof value.email === 'string' && value.email.length <= 320 ? { email: value.email } : {}) };
  }
  function connectionStatus(result: unknown): CompanionSnapshot {
    if (!isRecord(result) || typeof result.connected !== 'boolean') throw new Error('The companion returned an invalid connection status.');
    return { state: result.connected ? 'connected' : 'signedout', task: '', ...accountDetails(result),
      ...(result.connected && typeof result.email === 'string' && result.email.length <= 320 ? { email: result.email } : {}) };
  }
  const reply = (current: CompanionSnapshot) => ({ connected: current.state === 'connected', ...accountDetails({ ...current }), ...(current.email ? { email: current.email } : {}) });
  function failure(error: unknown) { return error instanceof Error ? error.message.slice(0, 1000) : 'The companion request could not be completed.'; }
  async function loadModels(current: CompanionSnapshot) {
    await save({ ...current, task: 'models' });
    const result = await companion('models');
    if (!isRecord(result) || !Array.isArray(result.models)) throw new Error('The companion returned an invalid model catalog.');
    const models = result.models.filter(item => isRecord(item) && typeof item.id === 'string' && item.id.trim() && item.id.length <= 200 && typeof item.name === 'string' && item.name.trim() && item.name.length <= 300)
      .map(item => ({ id: item.id as string, name: item.name as string, ...(typeof item.supportsImages === 'boolean' ? { supportsImages: item.supportsImages } : {}) }));
    await browser.storage.session.set({ chatGPTModelCatalog: models });
    await save({ ...current, state: 'connected', task: '' });
    return { models };
  }
  async function execute(command: CompanionCommand, options: AccountOptions): Promise<unknown> {
    const current = await snapshot();
    if (command === 'status' && Date.now() < freshUntil && ['connected', 'signedout'].includes(current.state)) {
      return reply(current);
    }
    if (command === 'signIn' || command === 'disconnect') await browser.storage.session.remove('chatGPTModelCatalog');
    await save({ ...current, ...(command === 'signIn' ? { state: 'checking' as const } : {}), task: command });
    try {
      if (command === 'models') {
        if (current.state === 'signedout') { await save(current); return { models: [] }; }
        return await loadModels(current);
      }
      const result = await companion(command, Object.keys(options).length ? options : undefined);
      const next = connectionStatus(result);
      const connected = next.state === 'connected';
      freshUntil = Date.now() + 30_000;
      if (!connected || next.selectedAccount !== current.selectedAccount) await browser.storage.session.remove('chatGPTModelCatalog');
      await save(next);
      if (connected && !Array.isArray((await browser.storage.session.get('chatGPTModelCatalog')).chatGPTModelCatalog)) {
        try { await loadModels(next); }
        catch (error) { await save({ ...next, error: failure(error) }); }
      }
      return reply(next);
    } catch (error) {
      let next: CompanionSnapshot = command === 'models' && current.state === 'connected' ? current : { state: 'unavailable', task: '', ...accountDetails({ ...current }) };
      if (command === 'signIn' || command === 'removeAccount') {
        try { next = connectionStatus(await companion('status')); } catch { /* Preserve known saved accounts if the companion is unavailable. */ }
      }
      if (command !== 'models') await browser.storage.session.remove('chatGPTModelCatalog');
      if (next.state === 'connected' && command !== 'models') {
        try { await loadModels(next); } catch { /* Preserve the original account-operation error. */ }
      }
      await save({ ...next, task: '', error: failure(error) });
      freshUntil = 0;
      throw error;
    }
  }
  return function request(command: CompanionCommand, options: AccountOptions = {}): Promise<unknown> {
    // Read requests from another window must not start a second sign-in. An opposing
    // account action creates a new group so sign-in after disconnect remains meaningful.
    const intent = `${command}:${options.accountId ?? ''}:${options.newAccount === true}`;
    if (['signIn', 'disconnect', 'removeAccount'].includes(command) && intent !== accountIntent) {
      accountIntent = intent; generation++;
    }
    const key = `${generation}:${intent}`;
    const existing = pending.get(key);
    if (existing) return existing;
    const promise = queue.catch(() => {}).then(() => execute(command, options));
    queue = promise.then(() => {}, () => {});
    pending.set(key, promise);
    void promise.finally(() => { if (pending.get(key) === promise) pending.delete(key); }).catch(() => {});
    return promise;
  };
}
