// Isolated process: mount the real App twice against a shared extension event bus.
import { mock } from 'bun:test';
import { strict as assert } from 'node:assert';
import { Window } from 'happy-dom';
import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import { defaultSettings } from '../src/settings';
import type { HistoryResult } from '../src/history';
import type { Request } from '../src/protocol';
import type { OfflinePackInfo } from '@veguide/core';

const window = new Window({ url: 'https://veguide.test/app.html' });
const document = window.document as unknown as Document;
Object.assign(globalThis, { window, document, location: window.location, navigator: window.navigator });
type MessageListener = (message: unknown, sender: { id?: string }) => unknown;
type StorageListener = (changes: Record<string, unknown>, area: string) => unknown;
const messageListeners = new Set<MessageListener>();
const storageListeners = new Set<StorageListener>();
let settings = { ...defaultSettings, model: 'fixture-vision' };
let history: HistoryResult[] = [];
let offlinePacks: OfflinePackInfo[] = [
  { region: 'Germany / EU', generatedAt: '2026-10-05T10:00:00Z', count: 1234, bundled: true },
  { region: 'Sweden', generatedAt: '2026-10-05T10:00:00Z', count: 987, bundled: false },
];
const email = 'fake-account@example.invalid';
const session: Record<string, unknown> = { chatGPTConnection: { state: 'connected', email }, chatGPTModelCatalog: [{ id: 'fixture-vision', name: 'Fixture Vision', supportsImages: true }] };
let nativeConnected = true;
const changed = (senderId = 'veguide') => { for (const listener of messageListeners) listener({ type: 'state-changed' }, { id: senderId }); };
function storageChanged(keys: string[], area: string) { for (const listener of storageListeners) listener(Object.fromEntries(keys.map(key => [key, {}])), area); }
mock.module('wxt/browser', () => ({ browser: {
  runtime: {
    id: 'veguide', getURL: (path: string) => `chrome-extension://veguide${path}`,
    onMessage: { addListener: (listener: MessageListener) => messageListeners.add(listener), removeListener: (listener: MessageListener) => messageListeners.delete(listener) },
    async sendMessage(message: Request) {
      switch (message.type) {
        case 'state': return { ok: true, result: structuredClone({ settings, history, hasKey: false, offlinePacks }) };
        case 'remove-offline-pack': offlinePacks = offlinePacks.filter(pack => pack.bundled || pack.region !== message.region); changed(); break;
        case 'update-settings': settings = { ...settings, ...message.patch }; storageChanged(['settings'], 'local'); break;
        case 'set-language': settings = { ...settings, language: message.language }; storageChanged(['settings'], 'local'); break;
        case 'delete': history = message.id ? history.filter(item => item.id !== message.id) : []; changed(); break;
        case 'companion':
          if (message.command === 'disconnect') nativeConnected = false;
          if (message.command === 'signIn') nativeConnected = true;
          session.chatGPTConnection = nativeConnected ? { state: 'connected', email } : { state: 'signedout' };
          if (!nativeConnected) delete session.chatGPTModelCatalog;
          storageChanged(['chatGPTConnection', 'chatGPTModelCatalog'], 'session');
          break;
        default: throw new Error(`Unexpected UI fixture request: ${message.type}`);
      }
      return { ok: true, result: null };
    },
  },
  storage: {
    session: { async get(keys: string | string[]) { return structuredClone(Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, session[key]]))); } },
    onChanged: { addListener: (listener: StorageListener) => storageListeners.add(listener), removeListener: (listener: StorageListener) => storageListeners.delete(listener) },
  },
  permissions: { async contains() { return true; }, async request() { return true; }, async remove() { return true; } },
  tabs: { async create() {}, async query() { return []; } },
} }));
const { App } = await import('../src/main');
const roots = [document.createElement('div'), document.createElement('div')];
roots.forEach((root, index) => { root.id = `window-${index}`; document.body.append(root); });
async function flush() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); }); }
async function until(test: () => boolean, description: string) {
  for (let count = 0; count < 30; count++) { await flush(); if (test()) return; }
  assert(test(), description);
}
async function tab(root: HTMLElement, index: number) { const button = root.querySelectorAll<HTMLButtonElement>('nav button')[index]; assert(button); await act(async () => { button.click(); }); await flush(); }
const emailButton = (root: HTMLElement) => root.querySelector<HTMLButtonElement>('.account-email');
const historyItems = (root: HTMLElement) => root.querySelectorAll('.history-item');
const fixtureResult: HistoryResult = {
  schemaVersion: 1, id: 'fixture-result', title: 'Composition looks vegan', summary: 'Fictional fixture result.', category: 'food', outcome: 'vegan', basis: 'composition',
  identity: { name: 'Fictional oat drink', market: 'DE', match: 'unconfirmed' }, findings: [], evidence: [], questions: [], warnings: [], crossContact: [], companyConcerns: [], checkedAt: '2026-10-05T10:00:00Z', usedAI: false,
};
try {
  await act(async () => { roots.forEach(root => render(h(App, {}), root)); });
  await until(() => roots.every(root => root.querySelector('nav')), 'Both real Apps mounted');
  await tab(roots[0]!, 1); await tab(roots[1]!, 1);
  assert(roots.every(root => historyItems(root).length === 0));
  history = [fixtureResult];
  changed('unrelated-extension');
  await flush();
  assert(roots.every(root => historyItems(root).length === 0), 'Foreign extension messages cannot invalidate the UI');
  changed();
  await until(() => roots.every(root => historyItems(root).length === 1), 'Shared history arrival refreshes both open windows');
  assert(roots.every(root => root.querySelector('nav .count')?.textContent === '1'));
  const trash = roots[0]!.querySelector<HTMLButtonElement>('.history-delete'); assert(trash);
  await act(async () => { trash.click(); });
  await until(() => roots.every(root => historyItems(root).length === 0 && !root.querySelector('nav .count')), 'Deletion in one window updates both histories and counts');
  assert(!roots[0]!.querySelector('.verdict'), 'Trash click does not open the result');

  await tab(roots[0]!, 2); await tab(roots[1]!, 2);
  const offlineSection = (root: HTMLElement) => root.querySelector('section[aria-labelledby="offline-heading"]');
  assert(roots.every(root => offlineSection(root)?.textContent?.includes('987')));
  assert(roots.every(root => offlineSection(root)?.querySelectorAll('button').length === 1), 'Only optional regional packs can be removed');
  await act(async () => { offlineSection(roots[0]!)!.querySelector<HTMLButtonElement>('button')!.click(); });
  await until(() => roots.every(root => !offlineSection(root)?.textContent?.includes('Sweden')), 'Removing an optional pack updates every open Settings screen');
  assert(roots.every(root => offlineSection(root)?.textContent?.includes('Germany / EU')), 'The bundled snapshot stays installed');
  await until(() => roots.every(root => emailButton(root)?.getAttribute('aria-pressed') === 'false'), 'Both connected accounts start hidden');
  assert(roots.every(root => !root.innerHTML.includes(email)), 'Hidden email is absent from text, attributes, and accessible labels');
  await act(async () => { emailButton(roots[0]!)!.click(); });
  assert(roots[0]!.textContent?.includes(email));
  assert(!roots[1]!.innerHTML.includes(email), 'Reveal state belongs only to the window that was tapped');
  await act(async () => { emailButton(roots[0]!)!.click(); });
  assert(!roots[0]!.innerHTML.includes(email));
  await act(async () => { emailButton(roots[0]!)!.click(); });
  await tab(roots[0]!, 0); await tab(roots[0]!, 2);
  assert.equal(emailButton(roots[0]!)?.getAttribute('aria-pressed'), 'false', 'Leaving Settings clears reveal state');
  await act(async () => { emailButton(roots[0]!)!.click(); window.dispatchEvent(new window.Event('blur')); });
  assert(!roots[0]!.innerHTML.includes(email), 'Window blur hides a revealed email');

  const historyPreference = roots[0]!.querySelector<HTMLInputElement>('input[type="checkbox"]'); assert(historyPreference?.checked);
  await act(async () => { historyPreference.click(); });
  await until(() => roots.every(root => root.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked === false), 'Saved preferences propagate to the other open window');
  await act(async () => { emailButton(roots[0]!)!.click(); });
  session.chatGPTConnection = { state: 'connected', email: 'another-fake@example.invalid', task: 'models' };
  session.chatGPTModelCatalog = [{ id: 'another-model', name: 'Shared replacement model' }];
  storageChanged(['chatGPTConnection', 'chatGPTModelCatalog'], 'session');
  await until(() => roots.every(root => root.textContent?.includes('Shared replacement model')), 'Shared model catalog updates both windows');
  assert(roots.every(root => !root.innerHTML.includes('another-fake@example.invalid') && !root.innerHTML.includes(email)), 'Account changes hide previously revealed identity');
  assert(roots.every(root => root.querySelector('.connection[aria-busy="true"]')), 'Shared connection activity is visible in both windows');
  session.chatGPTConnection = { state: 'signedout' }; delete session.chatGPTModelCatalog;
  storageChanged(['chatGPTConnection', 'chatGPTModelCatalog'], 'session');
  await until(() => roots.every(root => !emailButton(root) && root.textContent?.includes('Connect ChatGPT')), 'Disconnect reaches all windows without stale account details');
  history = [{ ...fixtureResult, outcome: 'uncertain', findings: [
    { term: 'naturlig arom', displayTerm: 'natural flavouring', displayLocale: 'en', status: 'ambiguous', explanation: 'Origin needs confirmation.', evidenceId: 'source' },
  ], questions: ['Confirm the origin of: naturlig arom.'], evidence: [{ id: 'source', kind: 'user_text', title: 'Original ingredients', excerpt: 'naturlig arom', retrievedAt: fixtureResult.checkedAt }] }];
  changed();
  await tab(roots[0]!, 1);
  await until(() => historyItems(roots[0]!).length === 1, 'Saved AI-translated result arrives');
  await act(async () => { (historyItems(roots[0]!)[0] as HTMLButtonElement).click(); });
  await until(() => roots[0]!.querySelector('.finding strong')?.textContent === 'natural flavouring', 'Saved AI ingredient translation appears in the actual result UI');
  assert.equal(roots[0]!.querySelector('.finding small')?.textContent, 'Original label: naturlig arom');
  assert(roots[0]!.textContent?.includes('Confirm the origin of: natural flavouring.'));
  assert(roots[0]!.querySelector('.evidence')?.textContent?.includes('naturlig arom'), 'Source evidence keeps its original words');
  console.log('Actual result UI: translated name/question and secondary original name preserve source evidence');
  console.log('Actual two-window UI: shared history/settings/session/model updates, trash isolation and private ephemeral email reveal verified');
} finally {
  await act(async () => { roots.forEach(root => render(null, root)); });
  assert.equal(messageListeners.size, 0, 'Unmount removes runtime listeners');
  assert.equal(storageListeners.size, 0, 'Unmount removes storage listeners');
  await window.happyDOM.close();
}
