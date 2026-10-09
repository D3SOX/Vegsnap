// Isolated process: module mocks here never leak into the core's real evaluator tests.
import { mock } from 'bun:test';
import { strict as assert } from 'node:assert';
import type { CheckInput, CheckOptions, ProviderConfig } from '@vegsnap/core';
import hostedConfig from '../../data/hosted-ai.json';
import { acceptsImages } from '../../packages/core/src/model-capabilities';
import { checkProduct as realCheckProduct } from '../../packages/core/src/check';
import { defaultSettings, STORES } from '../src/settings';
import type { CheckReply, Pending, Reply } from '../src/protocol';
type Sender = { id: string; url: string; tab?: { id: number } };
let listener: (message: unknown, sender: Sender) => Promise<Reply<unknown>>;
let startupListener: () => void;
let installedListener: () => void;
let browserLanguage = 'en-GB';
let extensionScheme = 'chrome-extension:';
let dataAllowed = true;
let menuTitle: string | undefined;
let permissionsRemovedListener: () => void;
const local: Record<string, unknown> = { settings: { ...defaultSettings, connection: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'test-model', stores: ['dm'] } };
const session: Record<string, unknown> = {};
const calls: CheckOptions[] = [];
const offlineIndex: NonNullable<CheckOptions['offlineProducts']> = { lookup: () => null };
let useRealEvaluator = false;
let providerExtractions = 0;
const offlineImports: string[] = [];
mock.module('../src/offline', () => ({ offlineLibrary: () => ({ index: async () => offlineIndex, info: async () => [],
  import: async (text: string) => { offlineImports.push(text); }, remove: async () => {} }) }));
const checkInputs: CheckInput[] = [];
const saved: unknown[] = [];
const providerConfigs: ProviderConfig[] = [];
const hostedProviderTokens: string[] = [];
let hostedRemaining = 3;
let hostedExtractionFails = false;
const progressMessages: unknown[] = [];
const historyOperations: string[] = [];
let historySaveGate: Promise<void> | undefined;
let historyDeleteGate: Promise<void> | undefined;
type NativeRequest = { id: string; command: string; payload?: unknown };
const nativeRequests: NativeRequest[] = [];
let nativeActive = 0, nativeMaximum = 0;
let nativeResponder: (request: NativeRequest) => Promise<unknown> = async request => request.command === 'models' ? { models: [{ id: 'vision', name: 'Vision', supportsImages: true }] } : { connected: request.command !== 'disconnect', email: 'fixture@example.invalid' };
function nativePort() {
  nativeActive++; nativeMaximum = Math.max(nativeMaximum, nativeActive);
  let ended = false;
  let messageListener: (message: unknown) => void = () => {};
  let disconnectListener: () => void = () => {};
  return {
    onMessage: { addListener(listener: typeof messageListener) { messageListener = listener; } },
    onDisconnect: { addListener(listener: typeof disconnectListener) { disconnectListener = listener; } },
    disconnect() { if (!ended) { ended = true; nativeActive--; disconnectListener(); } },
    postMessage(request: NativeRequest) {
      nativeRequests.push(request);
      void nativeResponder(request).then(result => messageListener({ id: request.id, ok: true, result }), error => messageListener({ id: request.id, ok: false, error: String(error instanceof Error ? error.message : error) }));
    },
  };
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function tick() { await new Promise(resolve => setTimeout(resolve, 0)); }

type RegisteredScript = { id: string; matches: string[]; js: string[] };
const registeredScripts: RegisteredScript[] = [{ id: 'unrelated-script', matches: [], js: [] }];
const unregistered: string[] = [];
const injectedTabs: number[] = [];
const notifiedTabs: { id: number; message: unknown }[] = [];
const openedTabs: string[] = [];
const deniedOrigins = new Set<string>();
const openTabs = [
  { id: 1, url: 'https://www.dm.de/example' },
  { id: 2, url: 'https://www.amazon.se/dp/TEST123456' },
  { id: 3, url: 'https://www.amazon.se.evil.example/' },
];
function matchesOrigin(url: string, pattern: string) {
  const host = new URL(url).hostname;
  const domain = pattern.replace('https://', '').replace('/*', '');
  return domain.startsWith('*.') ? host === domain.slice(2) || host.endsWith(`.${domain.slice(2)}`) : host === domain;
}
function storage(values: Record<string, unknown>) { return { async get(key: string) { return { [key]: values[key] }; }, async set(data: Record<string, unknown>) { Object.assign(values, data); }, async remove(key: string | string[]) { for (const item of Array.isArray(key) ? key : [key]) delete values[item]; } }; }
mock.module('wxt/browser', () => ({ browser: {
  i18n: { getUILanguage: () => browserLanguage },
  runtime: { id: 'vegsnap', connectNative: nativePort, async sendMessage(message: unknown) { progressMessages.push(message); }, getURL: (path: string) => `${extensionScheme}//vegsnap${path}`, onInstalled: { addListener(fn: () => void) { installedListener = fn; } }, onStartup: { addListener(fn: () => void) { startupListener = fn; } }, onMessage: { addListener(fn: typeof listener) { listener = fn; } } },
  storage: { local: storage(local), session: storage(session) },
  contextMenus: { onClicked: { addListener() {} }, async update(_id: string, properties: { title: string }) { if (menuTitle === undefined) throw new Error('Menu missing'); menuTitle = properties.title; }, create(properties: { title: string }) { assert.equal(menuTitle, undefined, 'Only one context menu is created'); menuTitle = properties.title; } },
  permissions: { async contains(request: { origins?: string[]; data_collection?: string[] }) { return (!request.data_collection || dataAllowed) && !(request.origins ?? []).some(origin => deniedOrigins.has(origin)); }, onRemoved: { addListener(fn: () => void) { permissionsRemovedListener = fn; } } },
  scripting: {
    async getRegisteredContentScripts() { return [...registeredScripts]; },
    async registerContentScripts(scripts: RegisteredScript[]) { registeredScripts.push(...scripts); },
    async unregisterContentScripts({ ids }: { ids: string[] }) { unregistered.push(...ids); for (let index = registeredScripts.length - 1; index >= 0; index--) if (ids.includes(registeredScripts[index]!.id)) registeredScripts.splice(index, 1); },
    async executeScript({ target }: { target: { tabId: number } }) { injectedTabs.push(target.tabId); },
  },
  tabs: {
    async query({ url }: { url: string[] }) { return openTabs.filter(tab => url.some(pattern => matchesOrigin(tab.url, pattern))); },
    async create({ url }: { url: string }) { openedTabs.push(url); },
    async sendMessage(id: number, message: unknown) { notifiedTabs.push({ id, message }); },
  },
} }));
mock.module('../src/history', () => ({ history: async (operation: string, value: unknown) => {
  if (operation !== 'list') historyOperations.push(`${operation}:start`);
  if (operation === 'save') { await historySaveGate; saved.push(value); }
  if (operation === 'delete') { await historyDeleteGate; saved.splice(0); }
  if (operation !== 'list') historyOperations.push(`${operation}:end`);
  return operation === 'list' ? saved : undefined;
} }));
mock.module('@vegsnap/core', () => ({
  HOSTED_AI: hostedConfig,
  createHostedAIProvider: (token: string) => { hostedProviderTokens.push(token); return { supportsWebSearch: true, extract: async () => {
    hostedRemaining = Math.max(0, hostedRemaining - 1);
    if (hostedExtractionFails) throw new Error('Hosted attempt failed');
    return { text: 'oats', complete: true, category: 'food' };
  } }; },
  acceptsImages,
  checkProduct: async (input: CheckInput, options: CheckOptions) => { checkInputs.push(input); calls.push(options); if (useRealEvaluator) return realCheckProduct(input, options); options.onProgress?.('ai'); options.onProgress?.('evaluating'); return { id: 'example', identity: { match: 'exact_barcode' }, checkedAt: new Date().toISOString() }; },
  createOpenAIProvider: (config: ProviderConfig) => { providerConfigs.push(config); return { extract: async () => { providerExtractions++; return { text: 'test', complete: false, category: 'other' }; } }; },
  validateAIExtraction: (value: unknown) => value,
  parseAIExtraction: () => ({ text: '', complete: false, category: 'other' }),
}));
const { default: background } = await import('../entrypoints/background');
background.main();
// Wait for initial registration's asynchronous storage/permission work to settle.
await new Promise(resolve => setTimeout(resolve, 0));
assert(registeredScripts.some(script => script.id === 'vegsnap-dm'), 'Saved opt-ins register on every background start, including extension reloads');
assert(!registeredScripts.some(script => script.id === 'vegsnap-amazon'), 'Startup does not opt into another store');
assert(injectedTabs.includes(1), 'Saved opt-ins activate in already open matching tabs');
assert(!injectedTabs.includes(2) && !injectedTabs.includes(3));
assert(registeredScripts.some(script => script.id === 'unrelated-script'), 'Registration only replaces Vegsnap scripts');
assert.equal(calls.length, 0, 'Activating integrations does not run an AI check');
const page: Sender = { id: 'vegsnap', url: 'https://www.dm.de/example', tab: { id: 1 } };
const trusted: Sender = { id: 'vegsnap', url: 'chrome-extension://vegsnap/app.html' };
assert.equal((await listener!({ type: 'state' }, page)).ok, false, 'Content scripts cannot read settings or credentials');
assert.equal((await listener!({ type: 'check', input: { text: 'milk' } }, page)).ok, false, 'Content scripts cannot run explicit AI');
assert.equal((await listener!({ type: 'background-check', barcode: '4006381333931' }, { ...page, url: 'https://www.dm.de.evil.example/' })).ok, false);
assert.equal((await listener!({ type: 'background-check', barcode: '4006381333931' }, page)).ok, true);
assert.equal(calls[0]?.mode, 'background');
assert.equal(calls[0]?.provider, undefined, 'Background requests must never receive an AI provider');
assert.equal(calls[0]?.offlineProducts, offlineIndex, 'Background barcode checks consult the on-device index first');
assert.equal(saved.length, 0, 'Browsing does not silently populate history');
assert.equal((await listener!({ type: 'check', input: { text: 'ingredients: milk' } }, trusted)).ok, true);
assert.equal(calls[1]?.mode, 'explicit');
assert(calls[1]?.provider);
assert.equal(calls[1]?.offlineProducts, offlineIndex, 'Explicit checks consult the same on-device index');
assert.equal(saved.length, 1);
assert.deepEqual((saved[0] as { input: CheckInput }).input, { text: 'ingredients: milk', locale: 'en', market: 'DE' }, 'History retains the original draft for editing');
assert.equal((await listener!({ type: 'set-api-token', endpoint: 'https://api.openai.com/v1', token: 'test-secret' }, trusted)).ok, true);
assert(!JSON.stringify(local).includes('test-secret'));
assert(JSON.stringify(session).includes('test-secret'));
assert.equal((await listener!({ type: 'check', input: { images: ['https://example.com/raw.jpg'] } }, trusted)).ok, false);
console.log('Background routing: trusted pages, site opt-in, database-only browsing, history and session credentials verified');

const originalSettings = local.settings;
delete local.settings;
let state = await listener!({ type: 'state' }, trusted);
assert(state.ok);
assert.equal((state.result as { settings: { language: string } }).settings.language, 'en', 'First launch follows the browser UI language');
local.settings = originalSettings;
assert.equal((await listener!({ type: 'set-language', language: 'en' }, page)).ok, false);
assert.equal((await listener!({ type: 'set-language', language: 'en' }, trusted)).ok, true);
assert.equal((local.settings as { model: string }).model, 'test-model', 'Changing language leaves provider settings untouched');
assert(JSON.stringify(session).includes('test-secret'), 'Changing language leaves credentials untouched');
assert.equal((await listener!({ type: 'update-settings', patch: { model: 'test-model' } }, trusted)).ok, true);
state = await listener!({ type: 'state' }, trusted);
assert(state.ok);
assert.equal((state.result as { settings: { language: string } }).settings.language, 'en', 'A provider field save cannot undo the saved language on reopen');
assert.equal((await listener!({ type: 'set-language', language: 'sv' }, trusted)).ok, false);
console.log('Language preference: browser default, immediate isolated save, and reopening verified');

assert.equal((await listener!({ type: 'set-chatgpt-model', model: 'chosen-model' }, page)).ok, false);
assert.equal((await listener!({ type: 'set-chatgpt-model', model: '' }, trusted)).ok, false);
assert.equal((await listener!({ type: 'set-chatgpt-model', model: 'chosen-model' }, trusted)).ok, true);
state = await listener!({ type: 'state' }, trusted);
assert(state.ok);
assert.deepEqual((state.result as { settings: { model: string; connection: string; language: string } }).settings, { ...(local.settings as object), model: 'chosen-model', connection: 'chatgpt', language: 'en' });
console.log('ChatGPT model selection is persisted immediately for checks and reopening');
for (const connection of ['hosted', 'database', 'openai']) {
  assert.equal((await listener!({ type: 'update-settings', patch: { connection } }, trusted)).ok, true);
  assert.equal((await listener!({ type: 'update-settings', patch: { connection: 'chatgpt' } }, trusted)).ok, true);
  state = await listener!({ type: 'state' }, trusted);
  assert(state.ok);
  assert.equal((state.result as { settings: { model: string } }).settings.model, 'chosen-model', 'Switching away and back restores the selected ChatGPT model');
}
console.log('ChatGPT selection survives hosted, database and API connection switching and settings reload');

assert.equal((await listener!({ type: 'update-settings', patch: { connection: 'openai' } }, page)).ok, false);
assert.equal((await listener!({ type: 'update-settings', patch: { connection: 'openai', baseUrl: 'https://api.openai.com/v1' } }, trusted)).ok, true);
await Promise.all([
  listener!({ type: 'update-settings', patch: { model: 'draft' } }, trusted),
  listener!({ type: 'update-settings', patch: { connection: 'openai' } }, trusted),
  listener!({ type: 'update-settings', patch: { saveHistory: false } }, trusted),
]);
assert.equal((local.settings as { model: string }).model, 'draft');
assert.equal((local.settings as { connection: string }).connection, 'openai');
assert.equal((local.settings as { saveHistory: boolean }).saveHistory, false);
assert.equal((await listener!({ type: 'set-api-token', endpoint: 'https://api.openai.com/v1', token: 'fixture-key' }, trusted)).ok, true);
assert(JSON.stringify(session).includes('fixture-key'));
assert.equal((await listener!({ type: 'update-settings', patch: { baseUrl: 'https://different.example/v1' } }, trusted)).ok, true);
assert(!JSON.stringify(session).includes('fixture-key'), 'Changing endpoint never carries its API key to a different endpoint');
assert.equal((await listener!({ type: 'set-api-token', endpoint: 'https://api.openai.com/v1', token: 'stale-key' }, trusted)).ok, false);
assert.equal((await listener!({ type: 'update-settings', patch: { baseUrl: 'htt' } }, trusted)).ok, true, 'Incomplete field drafts save without sending requests');
assert.equal((await listener!({ type: 'set-api-token', endpoint: 'htt', token: 'fixture-key' }, trusted)).ok, false);
assert(!JSON.stringify(local).includes('fixture-key'));
console.log('Automatic settings persistence: concurrent field edits, incomplete drafts and endpoint-bound credentials verified');

assert.equal((await listener!({ type: 'update-settings', patch: { baseUrl: 'https://old.example/v1' } }, trusted)).ok, true);
assert.equal((await listener!({ type: 'update-settings', patch: { baseUrl: 'https://api.openai.com/v1', model: 'new-model' } }, trusted)).ok, true);
assert.equal((await listener!({ type: 'set-api-token', endpoint: 'https://api.openai.com/v1', token: 'preserved-key' }, trusted)).ok, true);
assert.equal((await listener!({ type: 'set-store', store: 'amazon', enabled: true }, trusted)).ok, true);
assert.equal((local.settings as { model: string }).model, 'new-model', 'Store permission completion must preserve field edits made while permission was pending');
assert.equal((local.settings as { baseUrl: string }).baseUrl, 'https://api.openai.com/v1');
assert(JSON.stringify(session).includes('preserved-key'), 'Store toggle must not clear the current endpoint-bound token');

assert.equal((await listener!({ type: 'update-settings', patch: { baseUrl: 'https://private-api.example/v1', model: 'private-model' } }, trusted)).ok, true);
assert.equal((await listener!({ type: 'set-api-token', endpoint: 'https://private-api.example/v1', token: 'private-fixture' }, trusted)).ok, true);
assert.equal((await listener!({ type: 'update-settings', patch: { connection: 'hosted' } }, trusted)).ok, true);
assert.equal((session.credential as { token: string }).token, 'private-fixture', 'Hosted selection cannot erase the separate API key');
assert.equal((await listener!({ type: 'update-settings', patch: { connection: 'openai' } }, trusted)).ok, true);
assert.equal((local.settings as { baseUrl: string }).baseUrl, 'https://private-api.example/v1');
assert.equal((local.settings as { model: string }).model, 'private-model');
assert.equal((session.credential as { token: string }).token, 'private-fixture');
assert.equal((await listener!({ type: 'update-settings', patch: { baseUrl: 'https://api.openai.com/v1', model: 'new-model' } }, trusted)).ok, true);
console.log('Hosted connection switching preserves custom API settings and endpoint-bound credentials');

assert.equal((await listener!({ type: 'set-store', store: 'amazon', enabled: false }, page)).ok, false);
assert.equal((await listener!({ type: 'set-store', store: 'unknown', enabled: true }, trusted)).ok, false);
for (const patch of [{ connection: 'invalid' }, { connection: 7 }, { model: 'x'.repeat(201) }, { model: false }, { baseUrl: false }, { vision: 'yes' }]) assert.equal((await listener!({ type: 'update-settings', patch }, trusted)).ok, false);
assert.equal((await listener!({ type: 'save', settings: originalSettings }, trusted)).ok, false, 'Legacy whole-settings replacement is no longer accepted');
console.log('Store toggles preserve concurrent provider edits and endpoint credentials; invalid field patches are rejected');

// The UI resizes/re-encodes photos before dispatch. History must keep those exact
// local data URLs, never a remote image URL or a second provider-produced image.
const sanitizedPhotos = ['data:image/jpeg;base64,YQ==', 'data:image/jpeg;base64,Yg=='];
assert.equal((await listener!({ type: 'update-settings', patch: { connection: 'database', saveHistory: true } }, trusted)).ok, true);
const beforePhotoSave = saved.length;
let photoCheck = await listener!({ type: 'check', input: { text: 'Example label', images: sanitizedPhotos } }, trusted);
assert(photoCheck.ok);
assert.deepEqual((photoCheck.result as { photos: string[] }).photos, sanitizedPhotos);
assert.equal(saved.length, beforePhotoSave + 1);
assert.deepEqual((saved.at(-1) as { photos: string[] }).photos, sanitizedPhotos, 'History retains the sanitized photos supplied for this analysis');
assert.equal((saved.at(-1) as { input: CheckInput }).input.text, 'Example label');
assert.equal((saved.at(-1) as { input: CheckInput }).input.images, undefined, 'Drafts do not duplicate stored photos');
assert.deepEqual(checkInputs.at(-1)?.images, sanitizedPhotos, 'Analysis and local history refer to the same prepared photos');
const historyState = await listener!({ type: 'state' }, trusted);
assert(historyState.ok);
assert.deepEqual((historyState.result as { history: { photos?: string[] }[] }).history.at(-1)?.photos, sanitizedPhotos, 'Reopening history returns its locally stored photos');

assert.equal((await listener!({ type: 'update-settings', patch: { saveHistory: false } }, trusted)).ok, true);
const beforePrivateCheck = saved.length;
photoCheck = await listener!({ type: 'check', input: { images: sanitizedPhotos } }, trusted);
assert(photoCheck.ok);
assert.deepEqual((photoCheck.result as { photos: string[] }).photos, sanitizedPhotos, 'Photos remain visible for the current result with history disabled');
assert.equal(saved.length, beforePrivateCheck, 'Disabling history prevents both result and photo persistence');

for (const images of [['https://example.invalid/original.jpg'], ['data:image/svg+xml;base64,YQ==']]) {
  assert.equal((await listener!({ type: 'check', input: { images } }, trusted)).ok, false);
}
assert.equal(saved.length, beforePrivateCheck, 'Rejected image input never reaches local history');
console.log('Photo history: sanitized analysis inputs persist locally; disabled history and rejected images do not persist');

assert.equal((await listener!({ type: 'update-settings', patch: { connection: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-6-astra' } }, trusted)).ok, true);
assert.equal((await listener!({ type: 'check', input: { images: sanitizedPhotos } }, trusted)).ok, true);
assert.equal(providerConfigs.at(-1)?.supportsVision, true, 'Known image-capable models do not need a manual vision toggle');
assert.equal((await listener!({ type: 'update-settings', patch: { model: 'new-provider-model' } }, trusted)).ok, true);
await listener!({ type: 'check', input: { images: sanitizedPhotos } }, trusted);
assert.equal(providerConfigs.at(-1)?.supportsVision, true, 'Unknown model capabilities attempt vision instead of silently blocking photos');
assert.equal((await listener!({ type: 'update-settings', patch: { model: 'gpt-3.5-turbo' } }, trusted)).ok, true);
await listener!({ type: 'check', input: { images: sanitizedPhotos } }, trusted);
assert.equal(providerConfigs.at(-1)?.supportsVision, false, 'Known text-only models are recognized automatically');
assert.equal((await listener!({ type: 'update-settings', patch: { vision: false } }, trusted)).ok, false, 'Removed manual vision settings cannot disable automatic support');
console.log('Automatic photo capabilities: supported, unknown and text-only model routing verified');

const progressId = '56d52b1a-d038-4411-9d35-54405ab98b38';
const beforeProgress = progressMessages.length;
assert.equal((await listener!({ type: 'check', input: { text: 'private product text', images: sanitizedPhotos }, requestId: progressId }, trusted)).ok, true);
assert.deepEqual(progressMessages.slice(beforeProgress), [
  { type: 'check-progress', requestId: progressId, stage: 'ai' },
  { type: 'check-progress', requestId: progressId, stage: 'evaluating' },
], 'Only real phase events and a correlation ID are forwarded to extension pages');
assert(!JSON.stringify(progressMessages).includes('private product text'));
assert(!JSON.stringify(progressMessages).includes('data:image'));
assert.equal((await listener!({ type: 'check', input: { text: 'example' }, requestId: 'invalid' }, trusted)).ok, false);
assert.equal((await listener!({ type: 'check', input: { text: 'example' }, requestId: progressId }, page)).ok, false);
console.log('Check progress: correlated phase-only messages, invalid IDs and content-script request rejection verified');


const swedishPage: Sender = { id: 'vegsnap', url: 'https://www.amazon.se/dp/TEST123456', tab: { id: 2 } };
const swedishBarcode = '5012345678900';
assert.equal((await listener!({ type: 'set-store', store: 'amazon', enabled: false }, trusted)).ok, true);
assert(!registeredScripts.some(script => script.id === 'vegsnap-amazon'));
assert(unregistered.includes('vegsnap-amazon'), 'Disabling unregisters the automatic content script');
assert(notifiedTabs.some(tab => tab.id === 2 && JSON.stringify(tab.message) === JSON.stringify({ type: 'vegsnap-store-disabled' })), 'Disabling tells already open tabs to remove their integration');
assert.equal((await listener!({ type: 'background-check', barcode: swedishBarcode }, swedishPage)).ok, false, 'A permitted Amazon domain still requires store opt-in');
const beforeEnable = injectedTabs.length;
assert.equal((await listener!({ type: 'set-store', store: 'amazon', enabled: true }, trusted)).ok, true);
assert(registeredScripts.find(script => script.id === 'vegsnap-amazon')?.matches.includes('https://*.amazon.se/*'));
assert(injectedTabs.slice(beforeEnable).includes(2), 'Enabling injects into an already open matching Amazon tab');
assert(!injectedTabs.includes(3), 'A domain suffix lookalike is never injected');
deniedOrigins.add('https://www.amazon.se/*');
assert.equal((await listener!({ type: 'background-check', barcode: swedishBarcode }, swedishPage)).ok, false, 'Opt-in alone cannot bypass missing host access');
deniedOrigins.delete('https://www.amazon.se/*');
const beforeBackground = calls.length;
assert.equal((await listener!({ type: 'background-check', barcode: swedishBarcode }, swedishPage)).ok, true);
assert.equal(calls.length, beforeBackground + 1);
assert.equal(calls.at(-1)?.mode, 'background');
assert.equal(calls.at(-1)?.provider, undefined);
assert.equal(checkInputs.at(-1)?.market, 'SE');
assert.equal((await listener!({ type: 'background-check', barcode: swedishBarcode }, { ...swedishPage, url: 'https://www.amazon.se.evil.example/' })).ok, false);
assert.equal((await listener!({ type: 'background-check', name: 'Example granola', sourceUrl: swedishPage.url }, swedishPage)).ok, false, 'Background name lookups cannot trigger AI');

const beforeOpenCheck = calls.length;
const beforeOpenTabs = openedTabs.length;
const beforeHistory = saved.length;
assert.equal((await listener!({ type: 'open-check', name: 'Example granola', sourceUrl: swedishPage.url }, swedishPage)).ok, true);
assert.equal(calls.length, beforeOpenCheck, 'A click only opens a pending explicit check; the background does not start AI');
assert.equal(saved.length, beforeHistory);
assert.equal(openedTabs.length, beforeOpenTabs + 1);
const pendingId = new URL(openedTabs.at(-1)!).searchParams.get('pending');
assert(pendingId);
const pending = await listener!({ type: 'pending', id: pendingId }, trusted);
assert(pending.ok);
const pendingProduct = pending.result as Pending;
assert.equal(pendingProduct.name, 'Example granola');
assert.equal(pendingProduct.sourceUrl, swedishPage.url);
assert.equal(pendingProduct.market, 'SE');
assert.equal(pendingProduct.barcode, undefined);
assert.equal(typeof pendingProduct.createdAt, 'number');
assert.equal((await listener!({ type: 'pending', id: pendingId }, trusted)).ok, false, 'The pending product is consumed once');
for (const input of [
  { name: 'x'.repeat(501), sourceUrl: swedishPage.url },
  { name: 'Example', sourceUrl: 'https://www.amazon.se/' + 'x'.repeat(2001) },
  { name: 'Example', sourceUrl: 'https://www.amazon.de/dp/TEST123456' },
  { name: 'Example', sourceUrl: 'https://user:password@www.amazon.se/example' },
  { name: 'Example', sourceUrl: 'javascript:alert(1)' },
  { name: 'Example' },
]) assert.equal((await listener!({ type: 'open-check', ...input }, swedishPage)).ok, false, 'Pending product identity is bounded and its source must stay on the current site');
assert.equal(openedTabs.length, beforeOpenTabs + 1, 'Rejected product clicks never open a pending check');
assert.equal(calls.length, beforeOpenCheck);
console.log('Store lifecycle: reload activation, open-tab enable/disable, Amazon Sweden opt-in/permissions and bounded explicit product links verified');


// Existing users may have granted only Amazon.de before other marketplaces were added.
const amazon = STORES.find(store => store.id === 'amazon')!;
for (const origin of amazon.origins) {
  deniedOrigins.add(origin);
  deniedOrigins.add(origin.replace('*.', ''));
  if (origin !== 'https://*.amazon.de/*') deniedOrigins.add(origin.replace('*.', 'www.'));
}
startupListener!();
await new Promise(resolve => setTimeout(resolve, 0));
assert.deepEqual(registeredScripts.find(script => script.id === 'vegsnap-amazon')?.matches, ['https://www.amazon.de/*'], 'A saved opt-in retains its previously granted single-country access');
assert.equal((await listener!({ type: 'set-store', store: 'amazon', enabled: true }, trusted)).ok, false, 'Expanding a saved store opt-in still requires grants for the full requested scope');
assert((local.settings as { stores: string[] }).stores.includes('amazon'), 'A rejected permission expansion does not erase the existing opt-in');
console.log('Existing Amazon access: single-country grants survive reload without silently broadening permissions');

assert.equal((await listener!({ type: 'check', input: { name: 'Example granola', sourceUrl: swedishPage.url } }, trusted)).ok, true);
assert.equal(checkInputs.at(-1)?.market, 'SE', 'Starting the pending explicit check preserves its actual marketplace');
assert.equal((await listener!({ type: 'check', input: { name: 'Example granola', market: 'SE' } }, trusted)).ok, true);
assert.equal(checkInputs.at(-1)?.market, 'SE', 'Editing a saved check preserves its market without a source URL');
const beforeRevocation = notifiedTabs.length;
deniedOrigins.add('https://www.dm.de/*');
permissionsRemovedListener!();
await new Promise(resolve => setTimeout(resolve, 0));
assert(!registeredScripts.some(script => script.id === 'vegsnap-dm'));
assert(notifiedTabs.slice(beforeRevocation).some(tab => tab.id === 1), 'Revoking host access removes annotations from previously activated tabs even when their URL is no longer queryable');

// Cross-window state refreshes carry no product data, account credentials or tokens.
const beforeMutation = progressMessages.length;
await listener!({ type: 'set-language', language: 'de' }, trusted);
assert.equal(menuTitle, 'Mit Vegsnap prüfen', 'Saved extension language immediately updates the menu');
assert.deepEqual(progressMessages.slice(beforeMutation), [{ type: 'state-changed' }], 'A completed settings mutation refreshes every extension window');
await listener!({ type: 'update-settings', patch: { saveHistory: true } }, trusted);
const firstSave = deferred(), deletion = deferred();
historySaveGate = firstSave.promise;
historyDeleteGate = deletion.promise;
const beforeHistoryOperations = historyOperations.length;
const saving = listener!({ type: 'check', input: { text: 'fixture first save' } }, trusted);
await tick();
const deleting = listener!({ type: 'delete' }, trusted);
await tick();
const laterSaving = listener!({ type: 'check', input: { text: 'fixture later save' } }, trusted);
await tick();
firstSave.resolve();
await tick();
assert.deepEqual(historyOperations.slice(beforeHistoryOperations), ['save:start', 'save:end', 'delete:start'], 'A later save must wait for deletion, not run alongside it');
deletion.resolve();
await Promise.all([saving, deleting, laterSaving]);
historySaveGate = undefined; historyDeleteGate = undefined;
assert.deepEqual(historyOperations.slice(beforeHistoryOperations), ['save:start', 'save:end', 'delete:start', 'delete:end', 'save:start', 'save:end']);
assert.equal(saved.length, 1, 'The save requested after delete remains visible');

const signInGate = deferred();
local.settings = { ...(local.settings as object), connection: 'chatgpt', model: '', chatgptModel: '' };
nativeResponder = async request => {
  if (request.command === 'signIn') await signInGate.promise;
  return request.command === 'models' ? { models: [{ id: 'vision', name: 'Vision', supportsImages: true }, { id: 'gpt-6-luna', name: 'GPT-6 Luna', supportsImages: true }] } : { connected: request.command !== 'disconnect', email: 'fixture@example.invalid', access_token: 'never-persist-this-secret' };
};
const beforeSignIn = nativeRequests.length;
const connectingA = listener!({ type: 'companion', command: 'signIn' }, trusted);
const statusBetweenWindows = listener!({ type: 'companion', command: 'status' }, trusted);
const connectingB = listener!({ type: 'companion', command: 'signIn' }, trusted);
await tick();
assert.equal(nativeRequests.length, beforeSignIn + 1, 'Two windows share one sign-in');
assert.deepEqual(session.chatGPTConnection, { state: 'checking', task: 'signIn' });
signInGate.resolve();
await Promise.all([connectingA, statusBetweenWindows, connectingB]);
assert.deepEqual(nativeRequests.slice(beforeSignIn).map(request => request.command), ['signIn', 'models'], 'Sign-in loads a single shared catalog');
assert.deepEqual(session.chatGPTConnection, { state: 'connected', task: '', email: 'fixture@example.invalid' });
assert(!JSON.stringify(session).includes('never-persist-this-secret'));
assert.deepEqual(session.chatGPTModelCatalog, [{ id: 'vision', name: 'Vision', supportsImages: true }, { id: 'gpt-6-luna', name: 'GPT-6 Luna', supportsImages: true }]);
assert.equal((local.settings as { model: string }).model, 'gpt-6-luna', 'ChatGPT defaults to GPT-6 Luna when the account offers it');
await listener!({ type: 'set-chatgpt-model', model: 'vision' }, trusted);
await listener!({ type: 'companion', command: 'models' }, trusted);
assert.equal((local.settings as { model: string }).model, 'vision', 'Refreshing models preserves an explicit selection');
const beforeStatus = nativeRequests.length;
await Promise.all([listener!({ type: 'companion', command: 'status' }, trusted), listener!({ type: 'companion', command: 'status' }, trusted)]);
assert.equal(nativeRequests.length, beforeStatus, 'New windows reuse a recent completed connection snapshot');

const refreshGate = deferred();
nativeResponder = async request => {
  if (request.command === 'models') { await refreshGate.promise; return { models: [{ id: 'stale-model', name: 'Old' }] }; }
  return { connected: false };
};
const refreshing = listener!({ type: 'companion', command: 'models' }, trusted);
await tick();
const disconnecting = listener!({ type: 'companion', command: 'disconnect' }, trusted);
await tick();
assert.equal(nativeMaximum, 1, 'Companion operations never overlap across windows');
refreshGate.resolve();
await Promise.all([refreshing, disconnecting]);
assert.deepEqual(session.chatGPTConnection, { state: 'signedout', task: '' });
assert.equal(session.chatGPTModelCatalog, undefined, 'A late model response cannot restore a disconnected account catalog');

const { companion } = await import('../src/companion');
const checkGate = deferred();
nativeResponder = async request => { if (request.command === 'check') await checkGate.promise; return { connected: false }; };
const checking = companion('check', { text: 'fixture' });
await tick();
const beforeConcurrentStatus = nativeRequests.length;
const statusDuringCheck = companion('status');
await tick();
assert.equal(nativeRequests.length, beforeConcurrentStatus, 'Native status waits behind provider inference instead of contending for its OS lock');
checkGate.resolve();
await Promise.all([checking, statusDuringCheck]);
assert.equal(nativeMaximum, 1);
console.log('Cross-window synchronization: payload-free events, serialized history, shared connection/catalog, and native inference/status exclusion verified');

// Catalog failure must not undo a successful login; later windows see the same error.
nativeResponder = async request => {
  if (request.command === 'models') throw new Error('Catalog unavailable');
  return { connected: true, email: 'fixture@example.invalid', refresh_token: 'not-a-ui-field' };
};
const catalogFailure = await listener!({ type: 'companion', command: 'signIn' }, trusted);
assert(catalogFailure.ok);
assert(!JSON.stringify(catalogFailure).includes('not-a-ui-field'));
assert.deepEqual(session.chatGPTConnection, { state: 'connected', task: '', email: 'fixture@example.invalid', error: 'Catalog unavailable' });
assert.equal(session.chatGPTModelCatalog, undefined);
const failedCatalogCalls = nativeRequests.length;
await listener!({ type: 'companion', command: 'status' }, trusted);
assert.equal(nativeRequests.length, failedCatalogCalls, 'Opening another window does not endlessly retry a failed catalog');
nativeResponder = async () => { throw new Error('Companion unavailable'); };
assert.equal((await listener!({ type: 'companion', command: 'disconnect' }, trusted)).ok, false);
assert.deepEqual(session.chatGPTConnection, { state: 'unavailable', task: '', error: 'Companion unavailable' });
assert.equal(session.chatGPTModelCatalog, undefined);
assert.equal((await listener!({ type: 'companion', command: 'status' }, trusted)).ok, false);
assert.deepEqual(session.chatGPTConnection, { state: 'unavailable', task: '', error: 'Companion unavailable' });

// Opposing intents separate duplicate groups: sign-in after disconnect is a new operation.
const opposingGate = deferred();
let loginCount = 0;
nativeResponder = async request => {
  if (request.command === 'signIn' && ++loginCount === 1) await opposingGate.promise;
  return request.command === 'models' ? { models: [] } : { connected: request.command !== 'disconnect' };
};
const beforeOpposing = nativeRequests.length;
const firstLogin = listener!({ type: 'companion', command: 'signIn' }, trusted);
await tick();
const middleLogout = listener!({ type: 'companion', command: 'disconnect' }, trusted);
const finalLogin = listener!({ type: 'companion', command: 'signIn' }, trusted);
await tick();
opposingGate.resolve();
await Promise.all([firstLogin, middleLogout, finalLogin]);
assert.deepEqual(nativeRequests.slice(beforeOpposing).map(request => request.command), ['signIn', 'models', 'disconnect', 'signIn', 'models']);
assert.deepEqual(session.chatGPTConnection, { state: 'connected', task: '' });

const heldRequest = deferred();
nativeResponder = async () => { await heldRequest.promise; return {}; };
const activeRequest = companion('check');
await tick();
const beforeCancelled = nativeRequests.length;
const aborter = new AbortController();
const cancelledRequest = companion('status', undefined, aborter.signal).then(() => false, error => error instanceof DOMException && error.name === 'AbortError');
aborter.abort();
assert.equal(await Promise.race([cancelledRequest, new Promise(resolve => setTimeout(() => resolve('did not cancel promptly'), 50))]), true);
heldRequest.resolve();
await activeRequest;
await tick();
assert.equal(nativeRequests.length, beforeCancelled, 'Cancelled queued work never starts another native process');
assert.equal(nativeMaximum, 1);
const refreshEvents = progressMessages.filter(message => typeof message === 'object' && message !== null && 'type' in message && message.type === 'state-changed');
assert(refreshEvents.length >= 5);
assert(refreshEvents.every(message => JSON.stringify(message) === '{"type":"state-changed"}'), 'Cross-window refresh messages have no secret or product fields');
console.log('Companion boundaries: catalog/sign-in failures, unavailable state, opposing intents and immediate queued cancellation verified');

assert.equal((await listener!({ type: 'import-offline-pack', text: 'fixture-pack' }, page)).ok, false, 'Content scripts cannot replace offline data');
assert.equal((await listener!({ type: 'remove-offline-pack', region: 'Sweden' }, page)).ok, false);
assert.equal((await listener!({ type: 'import-offline-pack', text: 'fixture-pack' }, trusted)).ok, true);
assert.deepEqual(offlineImports, ['fixture-pack']);
console.log('Offline packs: local-first indexes for explicit/background checks and trusted-page-only import/remove routing verified');

// With no saved choice, installation uses the browser language. Saved choices win.
const savedSettings = local.settings;
delete local.settings; browserLanguage = 'de-DE';
installedListener!(); await tick();
assert.equal(menuTitle, 'Mit Vegsnap prüfen');
browserLanguage = 'sv-SE'; installedListener!(); await tick();
assert.equal(menuTitle, 'Check with Vegsnap', 'Unsupported browser languages use English');
local.settings = { ...defaultSettings, language: 'de' };
installedListener!(); await tick();
assert.equal(menuTitle, 'Mit Vegsnap prüfen', 'Extension language wins over browser language');
local.settings = savedSettings;
console.log('Context menu: a single localized label follows saved settings or the browser language');

// Firefox can revoke data consent independently of an existing host permission.
extensionScheme = 'moz-extension:';
dataAllowed = false;
const firefoxPage = { ...page, url: 'https://www.dm.de/example' };
const firefoxTrusted = { ...trusted, url: 'moz-extension://vegsnap/app.html' };
const beforeConsentDenial = calls.length;
assert.equal((await listener!({ type: 'background-check', barcode: '4006381333931' }, firefoxPage)).ok, false, 'Revoked consent also blocks cached/background requests');
assert.equal((await listener!({ type: 'set-store', store: 'dm', enabled: true }, firefoxTrusted)).ok, false, 'Host access alone cannot enable data sharing');
assert.equal(calls.length, beforeConsentDenial);
local.settings = { ...defaultSettings, connection: 'database', stores: ['dm'] };
permissionsRemovedListener!(); await tick();
assert(!registeredScripts.some(script => script.id === 'vegsnap-dm'), 'Revoking data consent unregisters the store script');
assert.equal((await listener!({ type: 'check', input: { text: 'ingredients: oats', complete: true } }, firefoxTrusted)).ok, true, 'Local checks remain available without consent');
await assert.rejects(() => calls.at(-1)!.fetch!('https://example.invalid'), /Allow data sharing/);
console.log('Firefox background: data revocation blocks cached checks, unregisters integrations, and preserves local checks');

// Exercise the real evaluator, including its offline-before-network ordering.
useRealEvaluator = true;
local.settings = { ...defaultSettings, language: 'en', connection: 'openai', model: 'fixture', baseUrl: 'https://api.openai.com/v1' };
deniedOrigins.add('https://api.openai.com/*');
const beforeExtractions = providerExtractions;
async function explicit(input: CheckInput) {
  const reply = await listener!({ type: 'check', input }, firefoxTrusted);
  assert(reply.ok);
  return reply.result as CheckReply;
}
for (const text of ['Ingredients: oats, sugar, sunflower oil', 'Ingredients: milk']) {
  const checked = await explicit({ text, complete: true, category: 'food' });
  assert.notEqual(checked.outcome, 'uncertain');
  assert.equal(checked.onlineConsent, undefined, 'Conclusive text needs no online consent, even with a configured AI model and revoked endpoint access');
}
offlineIndex.lookup = () => ({ input: { text: 'Ingredients: milk', complete: true, category: 'food' }, labels: [], evidence: {
  id: 'offline-fixture', kind: 'database', title: 'Offline fixture', excerpt: 'Milk', retrievedAt: new Date().toISOString(),
} });
const offlineCheck = await explicit({ barcode: '4006381333931' });
assert.equal(offlineCheck.identity.match, 'exact_barcode');
assert.equal(offlineCheck.onlineConsent, undefined, 'A local barcode match needs no data sharing');
offlineIndex.lookup = () => null;
const uncertainCheck = await explicit({ text: 'Ingredients: unspecified flavouring', complete: true });
assert.equal(uncertainCheck.outcome, 'uncertain');
assert.equal(uncertainCheck.onlineConsent, 'ai', 'Only an unresolved check offers AI consent');
assert.equal(providerExtractions, beforeExtractions, 'Declined sharing never invokes the provider');
const missingBarcode = await explicit({ barcode: '4006381333931' });
assert.equal(missingBarcode.onlineConsent, 'database', 'An offline miss offers database consent without losing local results');
dataAllowed = true;
assert.equal((await explicit({ text: 'Ingredients: unspecified flavouring', complete: true })).onlineConsent, 'ai', 'Data consent cannot bypass revoked endpoint access');
deniedOrigins.delete('https://api.openai.com/*');
await explicit({ text: 'Ingredients: unspecified flavouring', complete: true });
assert.equal(providerExtractions, beforeExtractions + 1, 'Granting data and endpoint access allows the requested provider check');
console.log('Real checks: conclusive text and offline barcodes survive declined sharing; online consent is offered only at needed network boundaries');

// Hosted sessions are shared by extension windows but never by product pages.
useRealEvaluator = false;
local.settings = { ...defaultSettings, connection: 'hosted', baseUrl: 'https://untrusted.example', model: 'ignored-client-model' };
const hostedRequests: Request[] = [];
const originalFetch = globalThis.fetch;
let heldHostedConnect: Promise<void> | undefined;
let hostedVerified = false;
let hostedExpired = false;
let hostedRefreshFails = false;
globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  const request = new Request(input, init);
  hostedRequests.push(request);
  assert.equal(new URL(request.url).origin, new URL(hostedConfig.baseUrl).origin);
  if (request.method === 'POST') { await heldHostedConnect; return Response.json({}, { status: 201 }); }
  if (request.method === 'DELETE') return Response.json({ disconnected: true });
  if (hostedRefreshFails) throw new Error('Temporary status failure');
  if (hostedExpired) return new Response('{}', { status: 401 });
  return Response.json({ state: hostedVerified ? 'connected' : 'pending', remaining: hostedRemaining, expiresAt: Date.now() + 86400000, enabled: true });
}, { preconnect: originalFetch.preconnect });
try {
  assert.equal((await listener!({ type: 'hosted', command: 'connect' }, firefoxPage)).ok, false);
  dataAllowed = false;
  assert.equal((await listener!({ type: 'hosted', command: 'connect' }, firefoxTrusted)).ok, false);
  dataAllowed = true;
  deniedOrigins.add(`${hostedConfig.baseUrl}/*`);
  assert.equal((await listener!({ type: 'hosted', command: 'connect' }, firefoxTrusted)).ok, false);
  deniedOrigins.delete(`${hostedConfig.baseUrl}/*`);
  assert.equal(hostedRequests.length, 0, 'Hosted setup respects both consent and host permissions');
  assert.equal((await listener!({ type: 'hosted', command: 'connect' }, firefoxTrusted)).ok, true);
  const credential = session.hostedCredential as { endpoint: string; token: string };
  assert.match(credential.token, /^[a-f0-9]{64}$/);
  assert.equal(credential.endpoint, hostedConfig.baseUrl);
  assert.equal(hostedRequests[0]!.headers.get('Authorization'), `Bearer ${credential.token}`);
  const verificationTab = new URL(openedTabs.at(-1)!);
  assert.equal(verificationTab.search, '');
  assert.equal(verificationTab.hash, `#token=${credential.token}`);
  const installationId = local.hostedInstallationId;
  assert.match(String(installationId), /^[a-f0-9]{64}$/);
  assert.deepEqual(await hostedRequests[0]!.clone().json(), { installationId });
  assert.equal((await listener!({ type: 'hosted', command: 'connect' }, firefoxTrusted)).ok, true);
  assert.equal((session.hostedCredential as { token: string }).token, credential.token, 'Connect resumes the pending session instead of minting a fresh allowance');
  assert(!JSON.stringify(local).includes(credential.token), 'Hosted secrets stay out of persistent browser storage');
  hostedVerified = true;
  assert.equal((await listener!({ type: 'hosted', command: 'status' }, firefoxTrusted)).ok, true);
  assert.deepEqual(session.hostedStatus, { state: 'connected', remaining: 3, expiresAt: (session.hostedStatus as { expiresAt: number }).expiresAt, enabled: true });
  await listener!({ type: 'check', input: { name: 'Unknown product' } }, firefoxTrusted);
  assert.equal(hostedProviderTokens.at(-1), credential.token);
  useRealEvaluator = true;
  const hostedPhoto = { images: ['data:image/jpeg;base64,AA=='] };
  const checked = await listener!({ type: 'check', input: hostedPhoto }, firefoxTrusted);
  assert(checked.ok);
  assert.equal((checked.result as { aiStatus: string }).aiStatus, 'images');
  assert.equal((session.hostedStatus as { remaining: number }).remaining, 2, 'Successful hosted checks immediately refresh the cached allowance');
  hostedExtractionFails = true;
  const failed = await listener!({ type: 'check', input: hostedPhoto }, firefoxTrusted);
  assert(failed.ok);
  assert.equal((failed.result as { aiStatus: string }).aiStatus, 'failed');
  assert.equal((session.hostedStatus as { remaining: number }).remaining, 1, 'Failed AI attempts also refresh consumed allowance');
  hostedExpired = true;
  await listener!({ type: 'check', input: hostedPhoto }, firefoxTrusted);
  assert.equal(session.hostedCredential, undefined, 'An expired hosted attempt immediately removes stale cached access');
  assert.equal(session.hostedStatus, undefined);
  hostedExpired = false; hostedExtractionFails = false;
  session.hostedCredential = credential;
  hostedRefreshFails = true;
  const statusFailed = await listener!({ type: 'check', input: hostedPhoto }, firefoxTrusted);
  assert(statusFailed.ok);
  assert.equal((statusFailed.result as { aiStatus: string }).aiStatus, 'images', 'A failed status refresh does not discard a successful product analysis');
  hostedRefreshFails = false; useRealEvaluator = false;
  assert.equal((await listener!({ type: 'hosted', command: 'disconnect' }, firefoxTrusted)).ok, true);
  assert.equal(hostedRequests.at(-1)!.method, 'DELETE');
  assert.equal(session.hostedCredential, undefined);
  assert.equal(session.hostedStatus, undefined);
  assert.equal(local.hostedInstallationId, installationId, 'Disconnect preserves the anonymous allowance identifier');
  await listener!({ type: 'check', input: { name: 'Unknown product' } }, firefoxTrusted);
  assert.equal(calls.at(-1)!.provider, undefined, 'Disconnect immediately removes AI access');
  session.hostedCredential = { endpoint: 'https://untrusted.example', token: 'a'.repeat(64) };
  const beforeInvalidEndpoint = hostedRequests.length;
  assert.equal((await listener!({ type: 'hosted', command: 'status' }, firefoxTrusted)).ok, true);
  assert.equal(hostedRequests.length, beforeInvalidEndpoint, 'A token for a different endpoint is unusable');
  delete session.hostedCredential;
  hostedVerified = false;
  const gate = deferred(); heldHostedConnect = gate.promise;
  const connecting = listener!({ type: 'hosted', command: 'connect' }, firefoxTrusted);
  await tick();
  const disconnecting = listener!({ type: 'hosted', command: 'disconnect' }, firefoxTrusted);
  gate.resolve();
  assert((await connecting).ok && (await disconnecting).ok);
  assert.equal(session.hostedCredential, undefined, 'An overlapping disconnect cannot resurrect a pending session');
} finally { globalThis.fetch = originalFetch; }
console.log('Hosted AI: fixed endpoint, temporary credentials, browser verification, consent, revocation and concurrent windows verified');

// Saved-account operations use only native registration IDs; tokens never reach extension state.
function sharedAccount(): import('../src/companion-state').CompanionSnapshot { return session.chatGPTConnection as import('../src/companion-state').CompanionSnapshot; }
extensionScheme = 'chrome-extension:'; dataAllowed = true;
local.settings = { ...defaultSettings, connection: 'chatgpt', model: 'vision', chatgptModel: 'vision' };
let savedAccounts = [{ id: 'first', email: 'first@example.invalid' }, { id: 'second', email: 'second@example.invalid' }];
let selectedAccount = 'first', accountConnected = true;
let declinedAccount: string | undefined;
let accountGate: Promise<void> | undefined;
nativeResponder = async request => {
  const payload = request.payload as { accountId?: string; newAccount?: boolean } | undefined;
  if (request.command === 'signIn') {
    await accountGate;
    if (payload?.accountId === declinedAccount && declinedAccount !== undefined) throw new Error('Sign-in declined');
    if (payload?.newAccount) { savedAccounts.push({ id: 'third', email: 'third@example.invalid' }); selectedAccount = 'third'; }
    else if (payload?.accountId) selectedAccount = payload.accountId;
    accountConnected = true;
  }
  if (request.command === 'removeAccount') {
    savedAccounts = savedAccounts.filter(account => account.id !== payload?.accountId);
    if (payload?.accountId === selectedAccount) { accountConnected = false; selectedAccount = savedAccounts[0]?.id ?? ''; }
  }
  if (request.command === 'disconnect') accountConnected = false;
  if (request.command === 'models') return { models: [{ id: 'gpt-6-luna', name: 'GPT-6 Luna' }, ...(selectedAccount === 'first' ? [{ id: 'vision', name: 'Vision' }] : [])] };
  return { connected: accountConnected, email: savedAccounts.find(account => account.id === selectedAccount)?.email,
    selectedAccount, savedAccounts: savedAccounts.map(account => ({ ...account, access_token: 'secret-account-token' })), refresh_token: 'secret-session-token' };
};
assert((await listener!({ type: 'companion', command: 'signIn', accountId: 'first' }, trusted)).ok);
assert.equal((local.settings as { model: string }).model, 'vision', 'Reconnecting preserves an explicit available model');
assert.deepEqual(sharedAccount().savedAccounts, savedAccounts);
assert(!JSON.stringify(session).includes('secret-account-token') && !JSON.stringify(session).includes('secret-session-token'));
assert((await listener!({ type: 'companion', command: 'signIn', accountId: 'second' }, trusted)).ok);
assert.equal((local.settings as { model: string }).model, 'gpt-6-luna', 'Switching to an account without the previous model defaults to Luna');
assert.equal(sharedAccount().selectedAccount, 'second');
assert.deepEqual(nativeRequests.filter(request => request.command === 'signIn').at(-1)?.payload, { accountId: 'second' });
const beforeInvalidAccounts = nativeRequests.length;
for (const message of [
  { command: 'signIn', accountId: 'second', newAccount: true },
  { command: 'signIn', accountId: '' },
  { command: 'signIn', accountId: 42 },
  { command: 'status', accountId: 'first' },
  { command: 'removeAccount' },
  { command: 'removeAccount', accountId: 'first', newAccount: true },
]) assert.equal((await listener!({ type: 'companion', ...message }, trusted)).ok, false);
assert.equal((await listener!({ type: 'companion', command: 'removeAccount', accountId: 'first' }, page)).ok, false, 'Content scripts cannot manage accounts');
assert.equal(nativeRequests.length, beforeInvalidAccounts, 'Invalid account requests never reach the companion');

declinedAccount = 'first';
assert.equal((await listener!({ type: 'companion', command: 'signIn', accountId: 'first' }, trusted)).ok, false);
assert.equal((session.chatGPTConnection as { state: string }).state, 'connected', 'A declined switch keeps the previous account connected');
assert.equal(sharedAccount().selectedAccount, 'second');
assert.equal(sharedAccount().savedAccounts?.length, 2);
declinedAccount = undefined;
const accountSignIn = deferred(); accountGate = accountSignIn.promise;
const beforeAccountQueue = nativeRequests.length;
const sameAccountA = listener!({ type: 'companion', command: 'signIn', accountId: 'first' }, trusted);
const sameAccountB = listener!({ type: 'companion', command: 'signIn', accountId: 'first' }, trusted);
const differentAccount = listener!({ type: 'companion', command: 'signIn', accountId: 'second' }, trusted);
await tick(); accountSignIn.resolve(); await Promise.all([sameAccountA, sameAccountB, differentAccount]); accountGate = undefined;
assert.deepEqual(nativeRequests.slice(beforeAccountQueue).filter(request => request.command === 'signIn').map(request => request.payload), [{ accountId: 'first' }, { accountId: 'second' }], 'Matching account intents coalesce while different account selections remain distinct');
assert.equal(sharedAccount().selectedAccount, 'second');
assert((await listener!({ type: 'companion', command: 'signIn', newAccount: true }, trusted)).ok);
assert.equal(sharedAccount().savedAccounts?.length, 3);
assert.deepEqual(nativeRequests.filter(request => request.command === 'signIn').at(-1)?.payload, { newAccount: true });
const catalogBeforeRemoval = session.chatGPTModelCatalog;
assert((await listener!({ type: 'companion', command: 'removeAccount', accountId: 'first' }, trusted)).ok);
assert.equal((session.chatGPTConnection as { state: string }).state, 'connected', 'Removing an inactive account keeps the active connection');
assert.deepEqual(session.chatGPTModelCatalog, catalogBeforeRemoval);
assert((await listener!({ type: 'companion', command: 'disconnect' }, trusted)).ok);
assert.equal(sharedAccount().savedAccounts?.length, 2, 'Disconnect keeps saved accounts');
assert.equal(session.chatGPTModelCatalog, undefined);
assert((await listener!({ type: 'companion', command: 'signIn', accountId: 'third' }, trusted)).ok);
assert((await listener!({ type: 'companion', command: 'removeAccount', accountId: 'third' }, trusted)).ok);
assert.equal((session.chatGPTConnection as { state: string }).state, 'signedout', 'Removing the connected account disconnects it');
assert.deepEqual(sharedAccount().savedAccounts, [{ id: 'second', email: 'second@example.invalid' }]);
assert.equal(session.chatGPTModelCatalog, undefined, 'Removing the active account discards its model catalog');
console.log('Saved ChatGPT accounts: trusted routing, native payloads, privacy, cross-window intents, declined switches, removal, reconnect and Luna defaults verified');
