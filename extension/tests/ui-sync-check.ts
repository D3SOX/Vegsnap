// Isolated process: mount the real App twice against a shared extension event bus.
import { mock } from 'bun:test';
import { strict as assert } from 'node:assert';
import { Window } from 'happy-dom';
import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import { defaultSettings, type Settings } from '../src/settings';
import type { HistoryResult } from '../src/history';
import type { CheckReply, Request } from '../src/protocol';
import type { CheckInput, OfflinePackInfo } from '@vegsnap/core';
import type { SavedAccount } from '../src/companion-state';

const window = new Window({ url: 'https://vegsnap.test/app.html' });
const document = window.document as unknown as Document;
Object.assign(globalThis, { window, document, location: window.location, navigator: window.navigator, Event: window.Event });
type MessageListener = (message: unknown, sender: { id?: string }) => unknown;
type StorageListener = (changes: Record<string, unknown>, area: string) => unknown;
const messageListeners = new Set<MessageListener>();
const storageListeners = new Set<StorageListener>();
let settings: Settings = { ...defaultSettings, connection: 'chatgpt', model: 'fixture-vision' };
let history: HistoryResult[] = [];
let offlinePacks: OfflinePackInfo[] = [
  { region: 'Germany / EU', generatedAt: '2026-10-05T10:00:00Z', count: 1234, bundled: true },
  { region: 'Sweden', generatedAt: '2026-10-05T10:00:00Z', count: 987, bundled: false },
];
const email = 'fake-account@example.invalid';
const session: Record<string, unknown> = { chatGPTConnection: { state: 'connected', email }, chatGPTModelCatalog: [{ id: 'fixture-vision', name: 'Fixture Vision', supportsImages: true }] };
let nativeConnected = true;
let uiSavedAccounts: SavedAccount[] | undefined;
let uiSelectedAccount = 'first';
const accountRequests: Extract<Request, { type: 'companion' }>[] = [];
let confirmAccountRemoval = true;
Object.assign(globalThis, { confirm: () => confirmAccountRemoval });
let extensionScheme = 'chrome-extension:';
let checkConsent: CheckReply['onlineConsent'];
let permissionRequests = 0, checkRequests = 0;
let startupWait: Promise<void> | undefined;
let checkWait: Promise<void> | undefined;
let checkError = false;
const checkedInputs: CheckInput[] = [];
let grantConsent = false;
let hostedVerified = false;
let hostedEnabled = true;
let hostedConnects = 0;
const changed = (senderId = 'vegsnap') => { for (const listener of messageListeners) listener({ type: 'state-changed' }, { id: senderId }); };
function storageChanged(keys: string[], area: string) { for (const listener of storageListeners) listener(Object.fromEntries(keys.map(key => [key, {}])), area); }
mock.module('wxt/browser', () => ({ browser: {
  runtime: {
    id: 'vegsnap', getURL: (path: string) => `${extensionScheme}//vegsnap${path}`,
    onMessage: { addListener: (listener: MessageListener) => messageListeners.add(listener), removeListener: (listener: MessageListener) => messageListeners.delete(listener) },
    async sendMessage(message: Request) {
      switch (message.type) {
        case 'check': {
          checkRequests++; checkedInputs.push(structuredClone(message.input)); await checkWait;
          if (checkError) return { ok: false, error: 'Fixture check failed' };
          const { images, ...input } = message.input;
          return { ok: true, result: { ...fixtureResult, input, ...(images?.length ? { photos: images } : {}), ...(checkConsent ? { onlineConsent: checkConsent } : {}) } };
        }
        case 'state': await startupWait; return { ok: true, result: structuredClone({ settings, history, hasKey: false, offlinePacks }) };
        case 'remove-offline-pack': offlinePacks = offlinePacks.filter(pack => pack.bundled || pack.region !== message.region); changed(); break;
        case 'update-settings': settings = { ...settings, ...message.patch }; storageChanged(['settings'], 'local'); break;
        case 'set-language': settings = { ...settings, language: message.language }; storageChanged(['settings'], 'local'); break;
        case 'delete': history = message.id ? history.filter(item => item.id !== message.id) : []; changed(); break;
        case 'hosted': {
          if (message.command === 'connect') hostedConnects++;
          const saved = session.hostedStatus as { state: string } | undefined;
          const status = { state: message.command === 'connect' ? 'pending' : message.command === 'disconnect' || !saved || saved.state === 'signedout' ? 'signedout' : hostedVerified ? 'connected' : 'pending', remaining: 3, enabled: hostedEnabled };
          session.hostedStatus = status;
          storageChanged(['hostedStatus'], 'session');
          return { ok: true, result: status };
        }
        case 'companion':
          accountRequests.push(message);
          if (message.command === 'disconnect') nativeConnected = false;
          if (message.command === 'signIn') nativeConnected = true;
          if (uiSavedAccounts !== undefined) {
            if (message.newAccount) { uiSavedAccounts.push({ id: 'third', email: 'third@example.invalid' }); uiSelectedAccount = 'third'; }
            if (message.command === 'signIn' && message.accountId) uiSelectedAccount = message.accountId;
            if (message.command === 'removeAccount') {
              uiSavedAccounts = uiSavedAccounts.filter(account => account.id !== message.accountId);
              if (uiSelectedAccount === message.accountId) { nativeConnected = false; uiSelectedAccount = uiSavedAccounts[0]?.id ?? ''; }
            }
            session.chatGPTConnection = { state: nativeConnected ? 'connected' : 'signedout', savedAccounts: structuredClone(uiSavedAccounts), selectedAccount: uiSelectedAccount,
              ...(nativeConnected ? { email: uiSavedAccounts.find(account => account.id === uiSelectedAccount)?.email } : {}) };
            if (nativeConnected) session.chatGPTModelCatalog = [{ id: 'gpt-6-luna', name: 'GPT-6 Luna' }];
          } else session.chatGPTConnection = nativeConnected ? { state: 'connected', email } : { state: 'signedout' };
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
  permissions: { async contains() { return true; }, async request() { permissionRequests++; return grantConsent; }, async remove() { return true; } },
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
  window.history.replaceState(null, '', '/popup.html');
  let finishStartup!: () => void;
  startupWait = new Promise(resolve => { finishStartup = resolve; });
  await act(async () => { render(h(App, {}), roots[0]!); });
  await flush();
  assert(!roots[0]!.querySelector('.spinner'), 'Opening the popup does not flash a spinner');
  assert(!roots[0]!.textContent?.includes('Checking the evidence'), 'Startup never claims to check evidence');
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 550)); });
  assert.equal(roots[0]!.querySelector('[role="status"]')?.textContent, 'Loading Vegsnap…', 'Slow startup explains what is loading');
  assert(roots[0]!.querySelector('.spinner'), 'Slow startup provides loading feedback');
  assert.equal(checkRequests, 0, 'Opening the popup does not run a product check');
  finishStartup(); startupWait = undefined;
  await until(() => !roots[0]!.querySelector('.spinner'), 'Startup feedback disappears when data is ready');
  await act(async () => { render(null, roots[0]!); });
  window.history.replaceState(null, '', '/app.html');

  await act(async () => { roots.forEach(root => render(h(App, {}), root)); });
  await until(() => roots.every(root => root.querySelector('nav')), 'Both real Apps mounted');
  assert(roots.every(root => !root.querySelector('.spinner')), 'Fast startup needs no loading indicator');
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
    { term: 'sugar', status: 'plant', explanation: 'Plant-derived ingredient.', evidenceId: 'source' },
    { term: 'gelatin', status: 'animal', explanation: 'Animal-derived ingredient.', evidenceId: 'source' },
    { term: 'unidentified ingredient', status: 'unknown', explanation: 'Origin has not been established.', evidenceId: 'source' },
  ], questions: ['Confirm the origin of: naturlig arom.'], evidence: [{ id: 'source', kind: 'user_text', title: 'Original ingredients', excerpt: 'naturlig arom', retrievedAt: fixtureResult.checkedAt }] }];
  changed();
  await tab(roots[0]!, 1);
  await until(() => historyItems(roots[0]!).length === 1, 'Saved AI-translated result arrives');
  await act(async () => { (historyItems(roots[0]!)[0] as HTMLButtonElement).click(); });
  await until(() => roots[0]!.querySelector('.finding strong')?.textContent === 'natural flavouring', 'Saved AI ingredient translation appears in the actual result UI');
  assert.equal(roots[0]!.querySelector('.finding small')?.textContent, 'Original label: naturlig arom');
  assert(roots[0]!.textContent?.includes('Confirm the origin of: natural flavouring, unidentified ingredient.'));
  assert(roots[0]!.querySelector('.evidence')?.textContent?.includes('naturlig arom'), 'Source evidence keeps its original words');
  const ingredientLabels = () => [...roots[0]!.querySelectorAll('.finding [role="img"]')].map(icon => icon.getAttribute('aria-label'));
  assert.deepEqual(ingredientLabels(), ['Ingredient origin unclear', 'Vegan ingredient', 'Animal-derived ingredient', 'Ingredient origin unknown'], 'Every ingredient has an accessible indicator that keeps uncertainty separate from animal origin');
  settings = { ...settings, language: 'de' };
  storageChanged(['settings'], 'local');
  await until(() => ingredientLabels()[0] === 'Herkunft der Zutat unklar', 'Ingredient indicator labels follow the selected language');
  assert.deepEqual(ingredientLabels(), ['Herkunft der Zutat unklar', 'Vegane Zutat', 'Zutat tierischen Ursprungs', 'Herkunft der Zutat unbekannt']);
  console.log('Actual result UI: translated name/question and secondary original name preserve source evidence');
  console.log('Actual two-window UI: shared history/settings/session/model updates, trash isolation and private ephemeral email reveal verified');

  settings = { ...settings, language: 'en' }; storageChanged(['settings'], 'local'); await flush();
  const editButton = () => roots[0]!.querySelector<HTMLButtonElement>('.edit-details');
  const beforeEdit = checkRequests;
  await act(async () => { editButton()!.click(); });
  assert.equal(roots[0]!.querySelector('h1')?.textContent, 'Edit product details');
  assert.equal(roots[0]!.querySelector('textarea')?.value, 'naturlig arom', 'Older history restores only supplied text');
  assert.equal(document.activeElement, roots[0]!.querySelector('textarea'), 'Editing focuses the details field');
  assert.equal(checkRequests, beforeEdit, 'Opening an edit does not run a check');
  const cancelButton = () => [...roots[0]!.querySelectorAll('button')].find(button => button.textContent === 'Cancel');
  await act(async () => { cancelButton()!.click(); });
  assert(roots[0]!.querySelector('.verdict'), 'Cancel returns to the original result');
  assert.equal(checkRequests, beforeEdit, 'Cancel does not run a check');

  const originalPhoto = 'data:image/jpeg;base64,YQ==';
  history = [{ ...fixtureResult, identity: { ...fixtureResult.identity, brand: 'Fixture Maker', barcode: '4006381333931', market: 'SE' },
    input: { text: 'Ingredients: oats', category: 'drink', complete: true, sourceUrl: 'https://www.amazon.se/dp/TEST123456' }, photos: [originalPhoto] }];
  changed(); await tab(roots[0]!, 1);
  await until(() => historyItems(roots[0]!).length === 1, 'Editable saved check is available');
  await act(async () => { (historyItems(roots[0]!)[0] as HTMLButtonElement).click(); });
  await act(async () => { editButton()!.click(); });
  const editText = roots[0]!.querySelector('textarea')!;
  assert.equal(editText.value, 'Ingredients: oats');
  assert.equal(roots[0]!.querySelector<HTMLSelectElement>('form select')?.value, 'drink');
  assert(roots[0]!.querySelector<HTMLInputElement>('form input[type="checkbox"]')?.checked, 'Original completeness is retained');
  assert.equal(roots[0]!.querySelector<HTMLImageElement>('.photos img')?.getAttribute('src'), originalPhoto, 'Saved photos can be edited');
  await act(async () => { editText.value += ', water'; editText.dispatchEvent(new Event('input', { bubbles: true })); });
  const submitEdit = async () => { await act(async () => { roots[0]!.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); }); };
  checkError = true; await submitEdit();
  await until(() => !!roots[0]!.querySelector('[role="alert"]'), 'Recheck errors are shown');
  assert.equal(roots[0]!.querySelector('textarea')?.value, 'Ingredients: oats, water', 'Failed checks retain the edited details');
  assert(cancelButton(), 'Failed checks retain the cancel action');
  checkError = false; await submitEdit();
  await until(() => !!roots[0]!.querySelector('.verdict'), 'Edited details produce a new result');
  assert.deepEqual(checkedInputs.at(-1), { text: 'Ingredients: oats, water', category: 'drink', complete: true, images: [originalPhoto],
    name: 'Fictional oat drink', brand: 'Fixture Maker', barcode: '4006381333931', market: 'SE', sourceUrl: 'https://www.amazon.se/dp/TEST123456' }, 'Rechecks retain identity while text is edited');
  assert.equal(history[0]?.input?.text, 'Ingredients: oats', 'Editing leaves the original saved check intact');
  await act(async () => { editButton()!.click(); });
  assert.equal(roots[0]!.querySelector('textarea')?.value, 'Ingredients: oats, water', 'Fresh results can be edited again');
  await act(async () => { roots[0]!.querySelector<HTMLButtonElement>('.photos button')!.click(); });
  assert.equal(roots[0]!.querySelectorAll('.photos img').length, 0, 'Existing photos can be removed from the draft');
  await act(async () => { cancelButton()!.click(); });
  assert(roots[0]!.querySelector('.history-photos img'), 'Cancelling photo edits preserves the checked result');
  await act(async () => { editButton()!.click(); });
  await act(async () => {
    const textarea = roots[0]!.querySelector('textarea')!;
    textarea.value += ' 5012345678900'; textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await submitEdit();
  await until(() => !!roots[0]!.querySelector('.verdict'), 'Correcting a saved barcode produces a new result');
  assert.equal(checkedInputs.at(-1)?.barcode, '5012345678900', 'A barcode supplied in edited text overrides the saved barcode');
  await act(async () => { editButton()!.click(); });
  await act(async () => {
    const textarea = roots[0]!.querySelector('textarea')!;
    textarea.value = textarea.value.replace('5012345678900', '').trim(); textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await submitEdit();
  await until(() => !!roots[0]!.querySelector('.verdict'), 'Removing a text barcode produces a new result');
  assert.equal(checkedInputs.at(-1)?.barcode, undefined, 'Deleting a barcode from the original text does not restore it from saved identity');
  history = [{ ...fixtureResult, input: { text: 'Ingredients: oats' } }];
  changed(); await tab(roots[0]!, 1);
  await until(() => historyItems(roots[0]!).length === 1, 'A saved result without a barcode is available');
  await act(async () => { (historyItems(roots[0]!)[0] as HTMLButtonElement).click(); });
  await act(async () => { editButton()!.click(); });
  await act(async () => {
    const textarea = roots[0]!.querySelector('textarea')!;
    textarea.value += ' 4006381333931'; textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await submitEdit();
  await until(() => !!roots[0]!.querySelector('.verdict'), 'Adding a barcode produces a new result');
  assert.equal(checkedInputs.at(-1)?.barcode, '4006381333931', 'Editing a barcode-less result preserves the newly supplied barcode for lookup');
  console.log('Actual editing UI: saved and fresh results, original input/photos, identity, focus, cancel and failed-check retry verified');

  extensionScheme = 'moz-extension:';
  settings = { ...settings, language: 'en' }; storageChanged(['settings'], 'local'); await flush();
  async function submitCheck() {
    await tab(roots[0]!, 0);
    const textarea = roots[0]!.querySelector('textarea'); assert(textarea);
    await act(async () => { textarea.value = 'Ingredients: oats'; textarea.dispatchEvent(new Event('input', { bubbles: true })); });
    await act(async () => { roots[0]!.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    await until(() => !!roots[0]!.querySelector('.verdict'), 'Local result is displayed');
  }
  let finishCheck!: () => void;
  checkWait = new Promise(resolve => { finishCheck = resolve; });
  const firstCheck = submitCheck();
  await until(() => !!roots[0]!.querySelector('.check-progress progress'), 'Product checks retain their progress indicator');
  assert.equal(roots[0]!.querySelector('.check-progress [role="status"]')?.textContent, 'Evaluating the evidence…');
  assert(roots[0]!.querySelector('.check-progress .spinner'), 'Actual checks still display a spinner');
  finishCheck(); checkWait = undefined;
  await firstCheck;
  assert(!roots[0]!.querySelector('.check-progress'), 'Check progress disappears after the result arrives');
  assert.equal(permissionRequests, 0, 'A local check never prompts before it runs');
  checkConsent = 'ai'; await submitCheck();
  const onlineButton = () => [...roots[0]!.querySelectorAll('button')].find(button => button.textContent === 'Allow online checks');
  await until(() => !!onlineButton(), 'An unresolved online operation offers an explicit consent action');
  const beforeConsentCheck = checkRequests;
  await act(async () => {
    onlineButton()!.click();
    assert.equal(permissionRequests, 1, 'Firefox permission request runs synchronously in the click handler');
  });
  await until(() => !!roots[0]!.textContent?.includes('Data sharing was not allowed'), 'Denied consent is explained');
  assert(roots[0]!.querySelector('.verdict'), 'Declining sharing keeps the local result visible');
  assert.equal(checkRequests, beforeConsentCheck, 'Declining sharing does not rerun or transmit the check');
  grantConsent = true; checkConsent = undefined;
  await act(async () => { onlineButton()!.click(); });
  await until(() => checkRequests === beforeConsentCheck + 1 && !onlineButton(), 'Granting access reruns the same input and clears the consent action');
  console.log('Actual check UI: local-first results, gesture-bound permission prompts, denial preservation and granted retry verified');
  await tab(roots[0]!, 2); await tab(roots[1]!, 2);
  const connections = roots[0]!.querySelectorAll<HTMLSelectElement>('select');
  const connectionSelect = [...connections].find(select => [...select.options].some(option => option.value === 'hosted')); assert(connectionSelect);
  await act(async () => { connectionSelect.value = 'hosted'; connectionSelect.dispatchEvent(new Event('change', { bubbles: true })); });
  const hostedSection = (root: HTMLElement) => root.querySelector('.connection[aria-label="Vegsnap AI — limited free checks"]');
  await until(() => roots.every(root => !!hostedSection(root)), 'Hosted provider selection updates both Settings screens');
  await until(() => roots.every(root => hostedSection(root)?.getAttribute('aria-busy') === 'false'), 'Initial session refresh finishes');
  assert(roots.every(root => !root.querySelector('input[type="password"]') && !root.querySelector('input[type="url"]')), 'Hosted access requires no user endpoint or API key');
  const beforeHostedConsent = permissionRequests;
  await act(async () => {
    hostedSection(roots[0]!)!.querySelector<HTMLButtonElement>('button')!.click();
    assert.equal(permissionRequests, beforeHostedConsent + 1, 'Hosted consent retains the Firefox click gesture');
  });
  await until(() => roots.every(root => hostedSection(root)?.textContent?.includes('Complete browser verification')), 'Pending browser verification is shared across windows');
  const continueVerification = [...hostedSection(roots[0]!)!.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Continue verification');
  assert(continueVerification, 'Pending sessions offer a way to reopen browser verification');
  const beforeReconnect = hostedConnects;
  await act(async () => { continueVerification.click(); });
  await until(() => hostedConnects === beforeReconnect + 1 && hostedSection(roots[0]!)?.getAttribute('aria-busy') === 'false', 'Continue verification routes through connect instead of only refreshing status');
  hostedVerified = true;
  await act(async () => { window.dispatchEvent(new window.Event('focus')); });
  await until(() => roots.every(root => hostedSection(root)?.textContent?.includes('Free checks remaining today: 3')), 'Returning from verification automatically shows the verified allowance');
  assert.equal(permissionRequests, beforeHostedConsent + 2, 'Only explicit connect gestures request data-sharing permissions');
  hostedEnabled = false;
  await act(async () => { window.dispatchEvent(new window.Event('focus')); });
  await until(() => roots.every(root => hostedSection(root)?.textContent?.includes('Free AI is temporarily unavailable.')), 'Disabled service shows unavailable in all windows despite valid connected sessions');
  assert(roots.every(root => !hostedSection(root)?.textContent?.includes('Free checks remaining today') && hostedSection(root)?.textContent?.includes('your own API key')), 'Unavailable service hides the allowance and guides users to another connection');
  hostedEnabled = true;
  await act(async () => { window.dispatchEvent(new window.Event('focus')); });
  await until(() => roots.every(root => hostedSection(root)?.textContent?.includes('Free checks remaining today: 3')), 'Re-enabled service restores access without reconnecting');
  session.hostedStatus = { state: 'pending' };
  await act(async () => { render(null, roots[1]!); render(h(App, {}), roots[1]!); });
  await tab(roots[1]!, 2);
  await until(() => hostedSection(roots[1]!)?.textContent?.includes('Free checks remaining today: 3') === true, 'Reopening the extension refreshes a saved pending session');
  const disconnectHosted = [...hostedSection(roots[0]!)!.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Disconnect'); assert(disconnectHosted);
  await act(async () => { disconnectHosted.click(); });
  await until(() => roots.every(root => hostedSection(root)?.textContent?.includes('Connect to free AI')), 'Disconnect returns every window to the connection action');
  console.log('Actual hosted UI: gesture-bound consent, automatic return/startup refresh and cross-window disconnect verified');

  uiSavedAccounts = [{ id: 'first', email }, { id: 'second', email: 'second@example.invalid' }];
  uiSelectedAccount = 'first'; nativeConnected = true;
  settings = { ...settings, connection: 'chatgpt', model: 'gpt-6-luna' }; storageChanged(['settings'], 'local');
  await tab(roots[0]!, 2); await tab(roots[1]!, 2);
  await until(() => roots.every(root => root.querySelectorAll('.account-select').length === 2), 'Saved accounts reach both Settings windows');
  assert(roots.every(root => !root.innerHTML.includes(email) && !root.innerHTML.includes('second@example.invalid')), 'Saved emails are hidden in text and accessible labels');
  assert.equal(roots[0]!.querySelector<HTMLSelectElement>('.connection label select')?.value, 'gpt-6-luna', 'Default model is shown in the picker');
  const savedEmailToggle = () => roots[0]!.querySelector<HTMLButtonElement>('.saved-accounts > button')!;
  await act(async () => { savedEmailToggle().click(); });
  assert(roots[0]!.textContent?.includes('second@example.invalid'));
  assert(!roots[1]!.innerHTML.includes('second@example.invalid'), 'Saved-email reveal remains local to one window');
  await act(async () => { window.dispatchEvent(new window.Event('blur')); });
  assert(!roots[0]!.innerHTML.includes('second@example.invalid'), 'Blur hides every saved email');
  const accountButtons = () => [...roots[0]!.querySelectorAll<HTMLButtonElement>('.account-select')];
  assert(accountButtons()[0]!.disabled, 'The currently connected account is marked and cannot reconnect unnecessarily');
  const permissionsBeforeSwitch = permissionRequests;
  await act(async () => { accountButtons()[1]!.click(); assert.equal(permissionRequests, permissionsBeforeSwitch + 1, 'Account switching requests consent from the click gesture'); });
  await until(() => roots.every(root => root.querySelectorAll<HTMLButtonElement>('.account-select')[1]?.disabled === true), 'Switching updates both windows');
  assert(accountRequests.some(request => request.command === 'signIn' && request.accountId === 'second'));
  const anotherAccount = () => [...roots[0]!.querySelectorAll<HTMLButtonElement>('.connection button')].find(button => button.textContent === 'Use another account')!;
  await act(async () => { anotherAccount().click(); });
  await until(() => roots.every(root => root.querySelectorAll('.account-select').length === 3), 'Adding another account refreshes both lists');
  assert(accountRequests.some(request => request.command === 'signIn' && request.newAccount === true));
  const removeButtons = () => [...roots[0]!.querySelectorAll<HTMLButtonElement>('.saved-accounts .history-delete')];
  confirmAccountRemoval = false;
  const beforeCancelledRemoval = accountRequests.length;
  await act(async () => { removeButtons()[2]!.click(); });
  assert.equal(accountRequests.length, beforeCancelledRemoval, 'Cancelling removal leaves the account untouched');
  confirmAccountRemoval = true;
  await act(async () => { removeButtons()[2]!.click(); });
  await until(() => roots.every(root => root.querySelectorAll('.account-select').length === 2 && !emailButton(root)), 'Removing the active account disconnects every window but preserves other saved accounts');
  assert(accountRequests.some(request => request.command === 'removeAccount' && request.accountId === 'third'));
  assert(roots.every(root => root.querySelector('.saved-accounts summary')?.textContent?.startsWith('Saved accounts')));
  grantConsent = false;
  const beforeDeclinedSignIn = accountRequests.length;
  await act(async () => { accountButtons()[0]!.click(); });
  await until(() => !!roots[0]!.querySelector('.connection [role="alert"]'), 'Declined sign-in consent is explained');
  assert.equal(accountRequests.length, beforeDeclinedSignIn, 'Declining consent never contacts the companion');
  assert(roots.every(root => root.querySelectorAll('.account-select').length === 2 && root.querySelector('.saved-accounts summary')?.textContent?.startsWith('Saved accounts')), 'Declining consent preserves saved-account controls');
  assert.equal(removeButtons().length, 2, 'Saved accounts can still be removed after declining consent');
  grantConsent = true;
  await act(async () => { accountButtons()[0]!.click(); });
  await until(() => roots.every(root => !!emailButton(root)), 'Saved accounts can reconnect after removal or disconnect');
  await act(async () => { removeButtons()[1]!.click(); });
  await until(() => roots.every(root => root.querySelectorAll('.account-select').length === 1 && !!emailButton(root)), 'Removing an inactive account preserves the connected account');
  settings = { ...settings, language: 'de' }; storageChanged(['settings'], 'local');
  await until(() => roots.every(root => root.querySelector('.saved-accounts summary')?.textContent?.startsWith('Konto wechseln')), 'Account management follows the UI language');
  await act(async () => { render(null, roots[1]!); render(h(App, {}), roots[1]!); });
  await tab(roots[1]!, 2);
  await until(() => roots[1]!.querySelectorAll('.account-select').length === 1, 'Saved accounts remain available after reopening Settings');
  console.log('Actual account-management UI: hidden emails, shared switching/add/remove, gesture consent, confirmation, reopening, translations and Luna selection verified');
} finally {
  await act(async () => { roots.forEach(root => render(null, root)); });
  assert.equal(messageListeners.size, 0, 'Unmount removes runtime listeners');
  assert.equal(storageListeners.size, 0, 'Unmount removes storage listeners');
  await window.happyDOM.close();
}
