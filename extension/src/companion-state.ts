import { browser } from 'wxt/browser';
import { companion } from './companion';
import { isRecord } from './protocol';

export type CompanionCommand = 'status' | 'signIn' | 'models' | 'disconnect';
export interface CompanionSnapshot {
  state: 'checking' | 'signedout' | 'connected' | 'unavailable';
  email?: string;
  task: '' | CompanionCommand;
  error?: string;
}

/** One background controller owns connection operations for every extension window. */
export function createCompanionState() {
  let queue = Promise.resolve();
  const pending = new Map<string, Promise<unknown>>();
  let accountIntent: 'signIn' | 'disconnect' | undefined;
  let generation = 0;
  let freshUntil = 0;
  const save = (snapshot: CompanionSnapshot) => browser.storage.session.set({ chatGPTConnection: snapshot });
  async function snapshot(): Promise<CompanionSnapshot> {
    const value: unknown = (await browser.storage.session.get('chatGPTConnection')).chatGPTConnection;
    if (!isRecord(value) || !['checking', 'signedout', 'connected', 'unavailable'].includes(String(value.state))) return { state: 'checking', task: '' };
    return { state: value.state as CompanionSnapshot['state'], task: '', ...(typeof value.email === 'string' && value.email.length <= 320 ? { email: value.email } : {}) };
  }
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
  async function execute(command: CompanionCommand): Promise<unknown> {
    const current = await snapshot();
    if (command === 'status' && Date.now() < freshUntil && ['connected', 'signedout'].includes(current.state)) {
      return { connected: current.state === 'connected', ...(current.email ? { email: current.email } : {}) };
    }
    if (command === 'signIn' || command === 'disconnect') await browser.storage.session.remove('chatGPTModelCatalog');
    await save(command === 'signIn' ? { state: 'checking', task: command } : { ...current, task: command });
    try {
      if (command === 'models') {
        if (current.state === 'signedout') { await save(current); return { models: [] }; }
        return await loadModels(current);
      }
      const result = await companion(command);
      if (!isRecord(result) || typeof result.connected !== 'boolean') throw new Error('The companion returned an invalid connection status.');
      const connected = command !== 'disconnect' && result.connected;
      const next: CompanionSnapshot = { state: connected ? 'connected' : 'signedout', task: '',
        ...(connected && typeof result.email === 'string' && result.email.length <= 320 ? { email: result.email } : {}) };
      freshUntil = Date.now() + 30_000;
      if (!connected) await browser.storage.session.remove('chatGPTModelCatalog');
      await save(next);
      if (connected && !Array.isArray((await browser.storage.session.get('chatGPTModelCatalog')).chatGPTModelCatalog)) {
        try { await loadModels(next); }
        catch (error) { await save({ ...next, error: failure(error) }); }
      }
      return { connected, ...(next.email ? { email: next.email } : {}) };
    } catch (error) {
      if (command !== 'models') await browser.storage.session.remove('chatGPTModelCatalog');
      await save({ ...(command === 'models' && current.state === 'connected' ? current : { state: 'unavailable' as const, task: '' as const }), task: '', error: failure(error) });
      throw error;
    }
  }
  return function request(command: CompanionCommand): Promise<unknown> {
    // Read requests from another window must not start a second sign-in. An opposing
    // account action creates a new group so sign-in after disconnect remains meaningful.
    if ((command === 'signIn' || command === 'disconnect') && command !== accountIntent) {
      accountIntent = command; generation++;
    }
    const key = `${generation}:${command}`;
    const existing = pending.get(key);
    if (existing) return existing;
    const promise = queue.catch(() => {}).then(() => execute(command));
    queue = promise.then(() => {}, () => {});
    pending.set(key, promise);
    void promise.finally(() => { if (pending.get(key) === promise) pending.delete(key); }).catch(() => {});
    return promise;
  };
}
