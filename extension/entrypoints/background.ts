import { browser } from 'wxt/browser';
import { countryCode, acceptsImages, checkProduct, createOpenAIProvider, createHostedAIProvider, HOSTED_AI, type CheckInput, type CheckResult } from '@vegsnap/core';
import { researchVeganAlternatives, validateAlternativeSearch, type AlternativeSearch } from '@vegsnap/core';
import { defineBackground } from 'wxt/utils/define-background';
import { companionProvider } from '../src/companion';
import { createCompanionState, type CompanionCommand } from '../src/companion-state';
import { hostedCommand, hostedToken } from '../src/hosted';
import { history, type HistoryResult } from '../src/history';
import { withoutCommunityHistory } from '../src/community-history';
import { offlineLibrary } from '../src/offline';
import { ACCOUNT_DATA, AI_DATA, CONTENT_DATA, aiFetch, contentFetch, hasDataConsent, requireDataConsent } from '../src/data-consent';
import { PRESETS, changeConnectionSettings, STORES, endpointOrigin, parseSettings, storeMarket, type Connection } from '../src/settings';
import { allowBackground, isBackgroundRequest, isCheckInput, isRecord, type CheckProgressMessage, type CheckReply, type Pending, type Reply } from '../src/protocol';

export default defineBackground(() => {
  const alternativeRequests = new Map<string, AbortController>();
  let historyQueue = Promise.resolve();
  let settingsQueue = Promise.resolve();
  const connection = createCompanionState();
  async function stateChanged() { try { await browser.runtime.sendMessage({ type: 'state-changed' }); } catch { /* No extension window is open. */ } }
  function changeHistory(work: () => Promise<void>) {
    const next = historyQueue.catch(() => {}).then(async () => { await work(); await stateChanged(); });
    historyQueue = next;
    return next;
  }
  function changeSettings(work: () => Promise<void>) {
    const next = settingsQueue.catch(() => {}).then(async () => { await work(); await stateChanged(); });
    settingsQueue = next;
    return next;
  }
  const cache = new Map<string, { result: CheckResult; time: number }>();
  const lastCheck = new Map<number, number>();
  async function settings() { return parseSettings((await browser.storage.local.get('settings')).settings, browser.i18n.getUILanguage()); }
  async function openCheck(input: Omit<Pending, 'createdAt'>) {
    const id = crypto.randomUUID();
    await browser.storage.session.set({ [`pending:${id}`]: { ...input, createdAt: Date.now() } });
    await browser.tabs.create({ url: browser.runtime.getURL('/app.html') + `?pending=${id}` });
  }
  let menuQueue = Promise.resolve();
  function syncContextMenu() {
    const next = menuQueue.catch(() => {}).then(async () => {
      const title = (await settings()).language === 'de' ? 'Mit Vegsnap prüfen' : 'Check with Vegsnap';
      try { await browser.contextMenus.update('vegsnap-check', { title }); }
      catch { browser.contextMenus.create({ id: 'vegsnap-check', title, contexts: ['selection', 'image'] }); }
    });
    menuQueue = next;
    return next;
  }
  browser.runtime.onInstalled.addListener(() => { void syncContextMenu(); });
  browser.runtime.onStartup.addListener(() => { void syncContextMenu(); });
  void syncContextMenu();
  browser.contextMenus.onClicked.addListener(info => {
    if (info.menuItemId === 'vegsnap-check') void openCheck({ ...(info.selectionText ? { text: info.selectionText.slice(0, 30_000) } : {}), ...(info.srcUrl ? { imageUrl: info.srcUrl } : {}) });
  });
  browser.runtime.onMessage.addListener((message: unknown, sender) => {
    const extensionPage = sender.id === browser.runtime.id && !!sender.url?.startsWith(browser.runtime.getURL('/'));
    const reply = async (): Promise<Reply<unknown>> => {
      let alternativeId: string | undefined;
      let alternativeController: AbortController | undefined;
      try {
        if (!isRecord(message) || typeof message.type !== 'string') throw new Error('Invalid request.');
        if (['research-alternatives', 'cancel-alternative-research'].includes(message.type)) {
          if (!extensionPage || typeof message.requestId !== 'string' || !/^[a-f0-9-]{36}$/.test(message.requestId)) throw new Error('Invalid alternative search request.');
          if (message.type === 'cancel-alternative-research') {
            alternativeRequests.get(message.requestId)?.abort();
            return { ok: true, result: null };
          }
          alternativeId = message.requestId;
          if (alternativeRequests.has(alternativeId)) throw new Error('Alternative search is already running.');
          alternativeController = new AbortController();
          alternativeRequests.set(alternativeId, alternativeController);
        }
        const config = await settings();
        if (!extensionPage) {
          if (sender.id !== browser.runtime.id || !isBackgroundRequest(message) || !allowBackground(sender.url, STORES.filter(store => config.stores.includes(store.id)).flatMap(store => store.origins))) throw new Error('This request is not allowed.');
          const origin = `${new URL(sender.url!).origin}/*`;
          if (!(await browser.permissions.contains({ origins: [origin] }))) throw new Error('Site permission has been removed.');
          await requireDataConsent(CONTENT_DATA);
          if (message.type === 'open-check') {
            const sourceUrl = message.sourceUrl ? new URL(message.sourceUrl) : undefined;
            if (sourceUrl && (sourceUrl.origin !== new URL(sender.url!).origin || sourceUrl.username || sourceUrl.password)) throw new Error('Invalid product link.');
            await openCheck({ barcode: message.barcode, name: message.name, brand: message.brand, sourceUrl: sourceUrl?.href, market: storeMarket(sender.url!) });
            return { ok: true, result: null };
          }
          const tab = sender.tab?.id;
          if (tab === undefined) throw new Error('Missing tab.');
          const cached = cache.get(`${config.language}:${storeMarket(sender.url!)}:${message.barcode}`);
          if (cached && Date.now() - cached.time < 3_600_000) return { ok: true, result: cached.result };
          if (Date.now() - (lastCheck.get(tab) ?? 0) < 1500) throw new Error('Please wait before the next lookup.');
          lastCheck.set(tab, Date.now());
          const result = await checkProduct({ barcode: message.barcode, locale: config.language, market: storeMarket(sender.url!) }, { mode: 'background', fetch: contentFetch, offlineProducts: await offlineLibrary().index() });
          if (cache.size > 200) cache.clear();
          cache.set(`${config.language}:${storeMarket(sender.url!)}:${message.barcode}`, { result, time: Date.now() });
          return { ok: true, result };
        }
        switch (message.type) {
          case 'state': { const key = (await browser.storage.session.get('credential')).credential; return { ok: true, result: { settings: config, history: await history('list'), offlinePacks: await offlineLibrary().info(), hasKey: isRecord(key) && key.endpoint === config.baseUrl && typeof key.token === 'string' && key.token.length > 0 } }; }
          case 'import-offline-pack': {
            if (typeof message.text !== 'string') throw new Error('Invalid offline pack.');
            await offlineLibrary().import(message.text);
            cache.clear(); await stateChanged();
            return { ok: true, result: null };
          }
          case 'remove-offline-pack': {
            if (typeof message.region !== 'string' || !message.region || message.region.length > 80) throw new Error('Invalid offline pack.');
            await offlineLibrary().remove(message.region);
            cache.clear(); await stateChanged();
            return { ok: true, result: null };
          }
          case 'set-language': {
            if (message.language !== 'en' && message.language !== 'de') throw new Error('Unsupported language.');
            const language = message.language;
            await changeSettings(async () => { await browser.storage.local.set({ settings: { ...await settings(), language } }); await syncContextMenu(); });
            return { ok: true, result: null };
          }
          case 'set-chatgpt-model': {
            if (typeof message.model !== 'string' || !message.model.trim() || message.model.length > 200) throw new Error('Invalid model.');
            const model = message.model;
            await changeSettings(async () => {
              const current = await settings();
              await browser.storage.local.set({ settings: { ...changeConnectionSettings(current, 'chatgpt'), model, chatgptModel: model } });
            });
            return { ok: true, result: null };
          }
          case 'update-settings': {
            if (!isRecord(message.patch)) throw new Error('Invalid settings.');
            const patch = message.patch;
            const allowed = ['connection', 'baseUrl', 'model', 'saveHistory', 'autoCountry', 'fallbackCountry'];
            if (Object.keys(patch).some(key => !allowed.includes(key))) throw new Error('Invalid setting.');
            if (patch.connection !== undefined && (typeof patch.connection !== 'string' || !['chatgpt', 'database', 'hosted', ...Object.keys(PRESETS)].includes(patch.connection)) ||
              patch.baseUrl !== undefined && (typeof patch.baseUrl !== 'string' || patch.baseUrl.length > 2000) ||
              patch.model !== undefined && (typeof patch.model !== 'string' || patch.model.length > 200) ||
              patch.fallbackCountry !== undefined && (typeof patch.fallbackCountry !== 'string' || !countryCode(patch.fallbackCountry)) ||
              ['saveHistory','autoCountry'].some(key => patch[key] !== undefined && typeof patch[key] !== 'boolean')) throw new Error('Invalid setting value.');
            await changeSettings(async () => {
              const current = await settings();
              const switched = typeof patch.connection === 'string' ? changeConnectionSettings(current, patch.connection as Connection) : current;
              const next = parseSettings({ ...switched, ...patch });
              if ((current.api?.baseUrl ?? current.baseUrl) !== (next.api?.baseUrl ?? next.baseUrl)) await browser.storage.session.remove('credential');
              await browser.storage.local.set({ settings: next });
            });
            return { ok: true, result: null };
          }
          case 'set-api-token': {
            if (typeof message.endpoint !== 'string' || typeof message.token !== 'string' || message.token.length > 10_000 || /[\r\n]/.test(message.token)) throw new Error('Invalid API key.');
            const endpoint = message.endpoint, token = message.token;
            endpointOrigin(endpoint);
            await changeSettings(async () => {
              const current = await settings();
              if (current.baseUrl !== endpoint || ['chatgpt', 'database', 'hosted'].includes(current.connection)) throw new Error('The endpoint changed. Enter the key for the current endpoint.');
              if (token) await browser.storage.session.set({ credential: { endpoint, token } });
              else await browser.storage.session.remove('credential');
            });
            return { ok: true, result: null };
          }
          case 'set-store': {
            const store = STORES.find(item => item.id === message.store);
            if (!store || typeof message.enabled !== 'boolean') throw new Error('Invalid store setting.');
            const enabled = message.enabled;
            let stores: string[] = [];
            await changeSettings(async () => {
              if (enabled && !(await browser.permissions.contains({ origins: [...store.origins] }))) throw new Error('Site permission was not granted.');
              if (enabled) await requireDataConsent(CONTENT_DATA);
              const current = await settings();
              stores = enabled ? [...new Set([...current.stores, store.id])] : current.stores.filter(id => id !== store.id);
              await browser.storage.local.set({ settings: { ...current, stores } });
              await syncScripts();
            });
            return { ok: true, result: stores };
          }
          case 'pending': {
            if (typeof message.id !== 'string' || !/^[a-f0-9-]{36}$/.test(message.id)) throw new Error('Invalid pending check.');
            const key = `pending:${message.id}`;
            const value: unknown = (await browser.storage.session.get(key))[key];
            await browser.storage.session.remove(key);
            if (!isRecord(value) || typeof value.createdAt !== 'number' || Date.now() - value.createdAt > 300_000) throw new Error('This check expired. Select the product again.');
            return { ok: true, result: value };
          }
          case 'research-alternatives':
          case 'check': {
            if (!isCheckInput(message.input)) throw new Error('Invalid product input.');
            if (message.requestId !== undefined && (typeof message.requestId !== 'string' || !/^[a-f0-9-]{36}$/.test(message.requestId))) throw new Error('Invalid check identifier.');
            const requestId = typeof message.requestId === 'string' ? message.requestId : undefined;
            const trustedStore = typeof message.input.sourceUrl === 'string' && allowBackground(message.input.sourceUrl, STORES.flatMap(store => store.origins));
            const input: CheckInput = { ...message.input, locale: config.language, market: message.input.market ?? (trustedStore ? storeMarket(message.input.sourceUrl!) : config.fallbackCountry), autoMarket: message.input.autoMarket ?? (trustedStore ? false : config.autoCountry) };
            let onlineConsent: CheckReply['onlineConsent'];
            let provider;
            if (config.connection === 'chatgpt' && config.model) {
              const catalog = (await browser.storage.session.get('chatGPTModelCatalog')).chatGPTModelCatalog;
              const metadata = Array.isArray(catalog) ? catalog.find(item => isRecord(item) && item.id === config.model) : undefined;
              provider = companionProvider(config.model, acceptsImages(config.model, metadata));
            }
            else if (config.connection === 'hosted') {
              const token = await hostedToken();
              if (token) provider = createHostedAIProvider(token, aiFetch);
            }
            else if (!['chatgpt', 'database'].includes(config.connection) && config.model) {
              const credential: unknown = (await browser.storage.session.get('credential')).credential;
              const token = isRecord(credential) && credential.endpoint === config.baseUrl && typeof credential.token === 'string' ? credential.token : undefined;
              provider = createOpenAIProvider({ baseUrl: config.baseUrl, token, model: config.model, supportsVision: acceptsImages(config.model) }, aiFetch);
            }
            // The evaluator consults local rules and the offline index first. Only
            // a network operation that is actually needed can ask for consent.
            if (provider) {
              const extract = provider.extract.bind(provider);
              provider.extract = async (...args) => {
                const data = config.connection === 'chatgpt' ? [...ACCOUNT_DATA, ...CONTENT_DATA] : AI_DATA;
                const hostAllowed = config.connection === 'chatgpt' || await browser.permissions.contains({ origins: [endpointOrigin(config.connection === 'hosted' ? HOSTED_AI.baseUrl : config.baseUrl)] });
                if (!hostAllowed || !(await hasDataConsent(data))) {
                  onlineConsent = 'ai';
                  throw new Error('Online AI access was not allowed; the local evidence was kept.');
                }
                try { return await extract(...args); }
                finally {
                  if (config.connection === 'hosted') await hostedCommand('status').catch(() => {});
                }
              };
            }
            if (message.type === 'research-alternatives') {
              const search = validateAlternativeSearch(message.input as AlternativeSearch);
              return { ok: true, result: provider ? await researchVeganAlternatives(search, provider, alternativeController?.signal) : [] };
            }
            const fetcher: typeof fetch = Object.assign(async (...args: Parameters<typeof fetch>) => {
              if (!(await hasDataConsent(CONTENT_DATA))) onlineConsent ??= 'database';
              return contentFetch(...args);
            }, { preconnect: globalThis.fetch.preconnect });
            const result = await checkProduct(input, { mode: 'explicit', provider, fetch: fetcher, offlineProducts: await offlineLibrary().index(), ...(requestId ? { onProgress(stage) {
              const progress: CheckProgressMessage = { type: 'check-progress', requestId, stage };
              void browser.runtime.sendMessage(progress).catch(() => {});
            } } : {}) });
            if (config.connection === 'database' && result.aiStatus === 'unconfigured') result.aiStatus = 'disabled';
            const inheritedFallback = message.input.autoMarket === undefined && !trustedStore && !config.autoCountry;
            if (inheritedFallback) result.identity.marketSource = 'fallback';
            const { images, ...savedInput } = input;
            if (inheritedFallback) delete savedInput.autoMarket;
            const localResult = { ...result, input: savedInput, ...(images?.length ? { photos: images } : {}) };
            if (config.saveHistory) await changeHistory(() => history('save', localResult));
            return { ok: true, result: { ...localResult, ...(onlineConsent ? { onlineConsent } : {}) } };
          }
          case 'set-result-market': {
            if (typeof message.id !== 'string' || typeof message.market !== 'string' || (!/^[A-Z]{2}$/.test(message.market) || !countryCode(message.market))) throw new Error('Invalid product country.');
            const id = message.id, market = message.market;
            let updated: HistoryResult | null = null;
            await changeHistory(async () => {
              const saved = (await history('list')).find(item => item.id === id);
              if (!saved) throw new Error('This result is no longer in history.');
              const corrected = { ...withoutCommunityHistory(saved), identity: { ...saved.identity, market, marketSource: 'manual' as const }, ...(saved.input ? {input:{...saved.input,market,autoMarket:false}} : {}) };
              await history('save', corrected);
              updated = corrected;
            });
            return { ok: true, result: updated };
          }
          case 'cache-community-result': {
            if (typeof message.expected !== 'string' || !isRecord(message.result) || typeof message.result.id !== 'string') throw new Error('Invalid community cache update.');
            const expected = message.expected, result = message.result as unknown as HistoryResult;
            let updated: HistoryResult | null = null;
            await changeHistory(async () => {
              const saved = (await history('list')).find(item => item.id === result.id);
              if (!saved || JSON.stringify(saved) !== expected || JSON.stringify(result) === expected) return;
              await history('save', result);
              updated = result;
            });
            return { ok: true, result: updated };
          }
          case 'delete': await changeHistory(() => history('delete', typeof message.id === 'string' ? message.id : undefined)); return { ok: true, result: null };
          case 'hosted': {
            if (!['connect', 'status', 'disconnect'].includes(String(message.command))) throw new Error('Invalid hosted command.');
            const result = await hostedCommand(message.command as 'connect' | 'status' | 'disconnect');
            await stateChanged();
            return { ok: true, result };
          }
          case 'companion': {
            if (!['status', 'signIn', 'disconnect', 'models', 'removeAccount'].includes(String(message.command))) throw new Error('Invalid companion command.');
            if (message.accountId !== undefined && (typeof message.accountId !== 'string' || !message.accountId.trim() || message.accountId.length > 1000 || /[\u0000-\u001f\u007f]/.test(message.accountId)) ||
              message.newAccount !== undefined && typeof message.newAccount !== 'boolean' || message.newAccount === true && message.accountId !== undefined ||
              message.command === 'removeAccount' && typeof message.accountId !== 'string' ||
              !['signIn', 'removeAccount'].includes(String(message.command)) && (message.accountId !== undefined || message.newAccount !== undefined) ||
              message.command === 'removeAccount' && message.newAccount !== undefined) throw new Error('Invalid saved account selection.');
            const result = await connection(message.command as CompanionCommand, {
              ...(typeof message.accountId === 'string' ? { accountId: message.accountId } : {}),
              ...(message.newAccount === true ? { newAccount: true } : {}),
            });
            if (message.command !== 'disconnect') await changeSettings(async () => {
              const catalog = (await browser.storage.session.get('chatGPTModelCatalog')).chatGPTModelCatalog;
              if (!Array.isArray(catalog)) return;
              const models = catalog.filter((item): item is { id: string; supportsImages?: boolean } => isRecord(item) && typeof item.id === 'string');
              const current = await settings();
              const selected = current.connection === 'chatgpt' ? current.model : current.chatgptModel;
              const model = models.find(item => item.id === selected)?.id ?? models.find(item => item.id === 'gpt-6-luna')?.id
                ?? models.find(item => item.supportsImages !== false)?.id ?? models[0]?.id;
              if (!model || model === selected) return;
              await browser.storage.local.set({ settings: { ...current, chatgptModel: model, ...(current.connection === 'chatgpt' ? { model } : {}) } });
            });
            return { ok: true, result };
          }
          default: throw new Error('Unknown request.');
        }
      } catch (error) { return { ok: false, error: error instanceof Error ? error.message : 'The check could not be completed.' }; }
      finally { if (alternativeId && alternativeRequests.get(alternativeId) === alternativeController) alternativeRequests.delete(alternativeId); }
    };
    return reply();
  });
  const integrationTabs = new Map<string, Set<number>>();
  let scriptsQueue = Promise.resolve();
  function syncScripts() {
    scriptsQueue = scriptsQueue.catch(() => {}).then(async () => {
      const config = await settings();
      const registered = (await browser.scripting.getRegisteredContentScripts()).filter(script => script.id.startsWith('vegsnap-'));
      if (registered.length) await browser.scripting.unregisterContentScripts({ ids: registered.map(script => script.id) });
      for (const store of STORES) {
        const granted: string[] = [];
        for (const origin of store.origins) {
          if (await browser.permissions.contains({ origins: [origin] })) granted.push(origin);
          else if (origin.includes('*.')) {
            // Keep a previously granted single-country permission usable until the user opts into all sites.
            for (const exact of [origin.replace('*.', 'www.'), origin.replace('*.', '')]) {
              if (await browser.permissions.contains({ origins: [exact] })) granted.push(exact);
            }
          }
        }
        const enabled = config.stores.includes(store.id) && await hasDataConsent(CONTENT_DATA);
        if (enabled && granted.length) await browser.scripting.registerContentScripts([{ id: `vegsnap-${store.id}`, matches: granted, js: ['content-scripts/store.js'], runAt: 'document_idle', persistAcrossSessions: true }]);
        const tabs = granted.length ? await browser.tabs.query({ url: granted }) : [];
        const activeIds = new Set(enabled ? tabs.flatMap(tab => tab.id === undefined ? [] : [tab.id]) : []);
        for (const id of integrationTabs.get(store.id) ?? []) if (!activeIds.has(id)) {
          try { await browser.tabs.sendMessage(id, { type: 'vegsnap-store-disabled' }); } catch { /* The old tab may no longer exist. */ }
        }
        integrationTabs.set(store.id, activeIds);
        for (const tab of tabs) if (tab.id !== undefined) {
          try {
            if (enabled) await browser.scripting.executeScript({ target: { tabId: tab.id }, files: ['/content-scripts/store.js'] });
            else await browser.tabs.sendMessage(tab.id, { type: 'vegsnap-store-disabled' });
          } catch { /* A tab may close or navigate while its integration is updated. */ }
        }
      }
    });
    return scriptsQueue;
  }
  browser.runtime.onStartup.addListener(() => { void syncScripts(); });
  browser.permissions.onRemoved.addListener(() => {
    for (const controller of alternativeRequests.values()) controller.abort();
    void syncScripts();
  });
  // Extension reloads do not emit browser.onStartup. Restore saved opt-ins on every background start.
  void syncScripts();
});
