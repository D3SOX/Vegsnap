import { HOSTED_AI, OFFLINE_MAX_BYTES, type OfflinePackInfo } from '@vegsnap/core';
import { render } from 'preact';
import { imageSupport, localizeResult } from '@vegsnap/core';
import { useEffect, useRef, useState } from 'preact/hooks';
import { browser } from 'wxt/browser';
import type { Category, CheckInput, CheckStage, Finding } from '@vegsnap/core';
import { messages } from './i18n';
import { PRESETS, changeConnectionSettings, STORES, defaultSettings, endpointOrigin, type Connection, type Settings } from './settings';
import { isRecord, scanInput, pendingInput, inspectedInput, type CheckReply, type Pending, type Reply, type Request, type State } from './protocol';
import { extractProducts } from './extraction';
import { sanitizeImage, readImageResponse } from './images';
import { editableInput, historyExport, type HistoryResult } from './history';
import './style.css';
import type { HostedStatus } from './hosted';
import { synchronizedRefresh } from './synchronization';
import { CompanyConcerns } from './company-concerns';
import { ManufacturerContactSection } from './manufacturer-contact';
import { CommunityRepliesSection } from './community-replies';
import { ACCOUNT_DATA, AI_DATA, CONTENT_DATA, contentFetch, requestDataConsent } from './data-consent';
import { accountDetails, type AccountOptions, type CompanionCommand, type CompanionSnapshot } from './companion-state';

async function request<T>(message: Request): Promise<T> {
  const reply = await browser.runtime.sendMessage(message) as Reply<T>;
  if (!reply.ok) throw new Error(reply.error);
  return reply.result;
}
function Leaf() { return <svg viewBox="0 0 32 32" aria-hidden="true"><path d="M26 5C11 4 4 11 7 21c10 5 20-2 19-16Z" fill="none" stroke="currentColor" stroke-width="2"/><path d="M5 28 21 11M12 21v-7m0 7h7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>; }
function Trash() { return <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18M9 6V4h6v2M5 6l1 14h12l1-14M10 10v6m4-6v6"/></svg>; }
function IngredientStatus({ status, language }: { status: Finding['status']; language: Settings['language'] }) {
  const t = messages[language];
  const label = status === 'plant' ? t.ingredientVegan : status === 'animal' ? t.ingredientAnimal : status === 'ambiguous' ? t.ingredientAmbiguous : t.ingredientUnknown;
  return <span class={`ingredient-status ${status}`} role="img" aria-label={label}>
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      {status === 'plant' ? <path d="m5 12 4 4L19 6"/> : status === 'animal' ? <path d="m6 6 12 12M18 6 6 18"/> : <><path d="M9 8a3 3 0 1 1 5 2.2c-1 .6-2 1.2-2 2.8"/><path d="M12 17h.01"/></>}
    </svg>
  </span>;
}
function safeLink(url: string | undefined): string | undefined { try { if (!url) return; const parsed = new URL(url); return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.href : undefined; } catch { return; } }
export function App() {
  const [config, setConfig] = useState<Settings>(defaultSettings);
  const [tab, setTab] = useState<'scan' | 'history' | 'settings'>('scan');
  const [savedHistory, setHistory] = useState<HistoryResult[]>([]);
  const [result, setResult] = useState<HistoryResult>();
  const [editingResult, setEditingResult] = useState<HistoryResult>();
  const [onlineCheck, setOnlineCheck] = useState<{ id: string; input: CheckInput; kind: 'database' | 'ai' }>();
  const [text, setText] = useState('');
  const [offlinePacks, setOfflinePacks] = useState<OfflinePackInfo[]>([]);
  const [inspectedIdentity, setInspectedIdentity] = useState<Pick<CheckInput, 'name' | 'brand' | 'barcode' | 'market' | 'sourceUrl'>>();
  const [category, setCategory] = useState<Category>('other');
  const [complete, setComplete] = useState(false);
  const [images, setImages] = useState<string[]>([]);
  const [imageUrl, setImageUrl] = useState<string>();
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [checkProgress, setCheckProgress] = useState<{ stage: CheckStage; startedAt: number }>();
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const activeCheckId = useRef<string>();
  const [ready, setReady] = useState(false);
  const [showStartupLoading, setShowStartupLoading] = useState(false);
  const activeModel = config.connection === 'hosted' ? HOSTED_AI.model : config.model;
  const [token, setToken] = useState('');
  const [hosted, setHosted] = useState<HostedStatus>({ state: 'signedout' });
  const [hostedBusy, setHostedBusy] = useState(false);
  const [hostedError, setHostedError] = useState('');
  const [hasKey, setHasKey] = useState(false);
  const [search, setSearch] = useState('');
  const [models, setModels] = useState<{ id: string; name: string; supportsImages?: boolean }[]>([]);
  const [emailRevealed, setEmailRevealed] = useState(false);
  const [account, setAccount] = useState<Omit<CompanionSnapshot, 'task' | 'error'>>({ state: 'checking' });
  const [connectionTask, setConnectionTask] = useState<'' | CompanionCommand | 'model'>('');
  const [connectionError, setConnectionError] = useState('');
  const [modelsLoaded, setModelsLoaded] = useState(false);
  const [languageSaving, setLanguageSaving] = useState(false);
  const [storeAccess, setStoreAccess] = useState<Record<string, boolean>>({});
  const connectionOperation = useRef(0);
  const settingsWrites = useRef<Promise<void>>(Promise.resolve());
  const credentialRevision = useRef(0);
  const hostedOperation = useRef(false);
  const configRef = useRef(config);
  const sharedRefresh = useRef<() => Promise<void>>(() => Promise.resolve());
  const resultHeading = useRef<HTMLHeadingElement>(null);
  const detailsField = useRef<HTMLTextAreaElement>(null);
  const t = messages[config.language];
  const isPopup = location.pathname.includes('popup');
  function refresh() { return sharedRefresh.current(); }
  useEffect(() => {
    const sync = synchronizedRefresh(async () => {
      // Finish local edits before adopting a shared snapshot.
      let pending: Promise<void>;
      do { pending = settingsWrites.current; await pending.catch(() => {}); } while (pending !== settingsWrites.current);
      const state = await request<State>({ type: 'state' });
      const shared = await browser.storage.session.get(['chatGPTConnection', 'chatGPTModelCatalog', 'hostedStatus']);
      return { state, shared, pending };
    }, ({ state, shared, pending }) => {
      if (pending !== settingsWrites.current) { void sync.refresh(); return; }
      if (configRef.current.baseUrl !== state.settings.baseUrl || configRef.current.connection !== state.settings.connection) {
        credentialRevision.current++; setToken('');
      }
      configRef.current = state.settings; setConfig(state.settings); setHistory(state.history); setHasKey(state.hasKey); setOfflinePacks(state.offlinePacks);
      const hostedStatus = shared.hostedStatus;
      setHosted(isRecord(hostedStatus) && ['pending', 'connected'].includes(String(hostedStatus.state)) ? hostedStatus as unknown as HostedStatus : { state: 'signedout' });
      const connection = shared.chatGPTConnection;
      if (isRecord(connection) && ['checking', 'signedout', 'connected', 'unavailable'].includes(String(connection.state))) {
        setAccount({ state: connection.state as CompanionSnapshot['state'], ...accountDetails(connection), ...(typeof connection.email === 'string' ? { email: connection.email } : {}) });
        setConnectionTask(['status', 'signIn', 'models', 'disconnect', 'removeAccount'].includes(String(connection.task)) ? connection.task as CompanionCommand : '');
        setConnectionError(typeof connection.error === 'string' ? connection.error : '');
      }
      const catalog = shared.chatGPTModelCatalog;
      setModels(Array.isArray(catalog) ? catalog.filter((model): model is { id: string; name: string; supportsImages?: boolean } => isRecord(model) && typeof model.id === 'string' && typeof model.name === 'string') : []);
      setModelsLoaded(Array.isArray(catalog));
    }, cause => setError(cause instanceof Error ? cause.message : 'Unable to synchronize Vegsnap.'));
    const changed = (message: unknown, sender: { id?: string }) => {
      if (sender.id === browser.runtime.id && isRecord(message) && message.type === 'state-changed') void sync.refresh();
      return undefined;
    };
    const storageChanged = (changes: Record<string, unknown>, area: string) => {
      if ((area === 'local' && 'settings' in changes) || (area === 'session' && ['credential', 'chatGPTConnection', 'chatGPTModelCatalog', 'hostedStatus', 'hostedCredential'].some(key => key in changes))) void sync.refresh();
    };
    const focus = () => {
      void sync.refresh();
      if (configRef.current.connection === 'hosted') void connectHosted('status');
    };
    const visible = () => { if (document.visibilityState === 'visible') focus(); };
    browser.runtime.onMessage.addListener(changed);
    browser.storage.onChanged.addListener(storageChanged);
    window.addEventListener('focus', focus);
    document.addEventListener('visibilitychange', visible);
    sharedRefresh.current = sync.refresh;
    return () => { sync.dispose(); browser.runtime.onMessage.removeListener(changed); browser.storage.onChanged.removeListener(storageChanged); window.removeEventListener('focus', focus); document.removeEventListener('visibilitychange', visible); };
  }, []);
  useEffect(() => { if (ready && config.connection === 'hosted') void connectHosted('status'); }, [ready, config.connection]);
  useEffect(() => { setEmailRevealed(false); }, [tab, account.email, account.state, account.selectedAccount]);
  useEffect(() => {
    const hide = () => setEmailRevealed(false);
    window.addEventListener('blur', hide); document.addEventListener('visibilitychange', hide);
    return () => { window.removeEventListener('blur', hide); document.removeEventListener('visibilitychange', hide); };
  }, []);
  async function act(work: () => Promise<void>) { setError(''); setNotice(''); setBusy(true); try { await work(); } catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to complete this action.'); } finally { setBusy(false); } }
  async function runCheck(input: CheckInput): Promise<HistoryResult> {
    setOnlineCheck(undefined);
    const requestId = crypto.randomUUID();
    activeCheckId.current = requestId;
    setElapsedSeconds(0); setCheckProgress({ stage: 'evaluating', startedAt: Date.now() });
    try {
      const checked = await request<CheckReply>({ type: 'check', input, requestId });
      if (checked.onlineConsent) setOnlineCheck({ id: checked.id, input, kind: checked.onlineConsent });
      return checked;
    }
    finally { if (activeCheckId.current === requestId) { activeCheckId.current = undefined; setCheckProgress(undefined); } }
  }
  async function check(input: CheckInput) {
    await act(async () => {
      await settingsWrites.current;
      const checked = await runCheck(input); setResult(checked); setEditingResult(undefined); setImages([]); setImageUrl(undefined); await refresh(); });
  }
  function editResult() {
    if (!result) return;
    const input = editableInput(result);
    setEditingResult(result); setResult(undefined); setTab('scan');
    setText(input.text ?? ''); setCategory(input.category ?? 'other'); setComplete(input.complete === true); setImages(input.images ?? []);
    setInspectedIdentity({ name: input.name, brand: input.brand, ...(input.barcode ? { barcode: input.barcode } : {}), market: input.market, sourceUrl: input.sourceUrl });
    setImageUrl(undefined); setError(''); setNotice('');
  }
  function cancelEdit() {
    setResult(editingResult); setEditingResult(undefined);
    setText(''); setCategory('other'); setComplete(false); setImages([]); setInspectedIdentity(undefined);
    setError(''); setNotice('');
  }
  function allowOnlineCheck() {
    if (!onlineCheck) return;
    const { input, kind } = onlineCheck;
    const current = configRef.current;
    const api = kind === 'ai' && !['chatgpt', 'database'].includes(current.connection);
    // Request immediately from this click, before any asynchronous work.
    const consent = requestDataConsent(kind === 'database' ? CONTENT_DATA : current.connection === 'chatgpt' ? [...ACCOUNT_DATA, ...CONTENT_DATA] : AI_DATA,
      api ? { origins: [endpointOrigin(current.connection === 'hosted' ? HOSTED_AI.baseUrl : current.baseUrl)] } : {});
    void act(async () => {
      if (!(await consent)) { setNotice(t.dataConsentDenied); return; }
      await settingsWrites.current;
      setResult(await runCheck(input)); await refresh();
    });
  }
  useEffect(() => {
    const onProgress = (message: unknown, sender: { id?: string }): undefined => {
      if (sender.id === browser.runtime.id && isRecord(message) && message.type === 'check-progress' && message.requestId === activeCheckId.current &&
        ['database', 'ai', 'evaluating'].includes(String(message.stage))) {
        setCheckProgress(previous => previous && ({ ...previous, stage: message.stage as CheckStage }));
      }
      return undefined;
    };
    browser.runtime.onMessage.addListener(onProgress);
    return () => { activeCheckId.current = undefined; browser.runtime.onMessage.removeListener(onProgress); };
  }, []);
  useEffect(() => {
    if (!checkProgress) return;
    const timer = setInterval(() => setElapsedSeconds(Math.floor((Date.now() - checkProgress.startedAt) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [checkProgress?.startedAt]);
  useEffect(() => {
    if (ready) return;
    const timer = setTimeout(() => setShowStartupLoading(true), 500);
    return () => clearTimeout(timer);
  }, [ready]);
  useEffect(() => {
    void act(async () => {
      await refresh(); setReady(true);
      const id = new URLSearchParams(location.search).get('pending');
      if (!id) return;
      const pending = await request<Pending>({ type: 'pending', id });
      window.history.replaceState(null, '', location.pathname);
      if (pending.imageUrl) { setImageUrl(pending.imageUrl); setText(pending.text ?? ''); }
      else { setText(pending.text ?? pending.barcode ?? ''); const checked = await runCheck(pendingInput(pending)); setResult(checked); await refresh(); }
    });
  }, []);
  useEffect(() => {
    if (ready && config.connection === 'chatgpt') void connect('status');
    return () => { connectionOperation.current++; };
  }, [ready, config.connection]);
  useEffect(() => {
    if (!ready) return;
    let active = true;
    void Promise.all(STORES.map(async store => [store.id, await browser.permissions.contains({ origins: [...store.origins] })] as const))
      .then(entries => { if (active) setStoreAccess(Object.fromEntries(entries)); }).catch(() => {});
    return () => { active = false; };
  }, [ready, config.stores]);
  useEffect(() => { document.documentElement.lang = config.language; }, [config.language]);
  useEffect(() => { if (result) resultHeading.current?.focus(); }, [result]);
  useEffect(() => { if (editingResult) detailsField.current?.focus(); }, [editingResult]);
  function localConfig(next: Settings) { configRef.current = next; setConfig(next); }
  function persist(message: Request, onSuccess?: () => void) {
    setError('');
    const operation = settingsWrites.current.catch(() => {}).then(() => request(message)).then(() => { onSuccess?.(); });
    settingsWrites.current = operation;
    void operation.catch(cause => setError(cause instanceof Error ? cause.message : 'Unable to save settings.'));
    return operation;
  }
  function update<K extends keyof Settings>(key: K, value: Settings[K]) {
    localConfig({ ...configRef.current, [key]: value });
    if (key === 'baseUrl') { credentialRevision.current++; setToken(''); setHasKey(false); }
    persist({ type: 'update-settings', patch: { [key]: value } });
  }
  function changeConnection(connection: Connection) {
    localConfig(changeConnectionSettings(configRef.current, connection)); credentialRevision.current++; setToken(''); setHasKey(false);
    persist({ type: 'update-settings', patch: { connection } });
  }
  function changeToken(value: string) {
    const revision = ++credentialRevision.current;
    setToken(value);
    try { endpointOrigin(configRef.current.baseUrl); }
    catch { setError(t.invalidEndpoint); return; }
    persist({ type: 'set-api-token', endpoint: configRef.current.baseUrl, token: value }, () => { if (revision === credentialRevision.current) setHasKey(Boolean(value)); });
  }
  async function changeLanguage(language: Settings['language']) {
    const previous = config.language;
    localConfig({ ...configRef.current, language }); setLanguageSaving(true); setError('');
    try { await persist({ type: 'set-language', language }); }
    catch (cause) { localConfig({ ...configRef.current, language: previous }); setError(cause instanceof Error ? cause.message : 'Unable to save language.'); }
    finally { setLanguageSaving(false); }
  }
  async function connectHosted(command: 'connect' | 'status' | 'disconnect') {
    if (hostedOperation.current) return;
    hostedOperation.current = true;
    const consent = command === 'connect' ? requestDataConsent(AI_DATA, { origins: [endpointOrigin(HOSTED_AI.baseUrl)] }) : Promise.resolve(true);
    setHostedBusy(true); setHostedError('');
    try {
      if (!(await consent)) throw new Error(t.dataConsentDenied);
      setHosted(await request<HostedStatus>({ type: 'hosted', command }));
      await refresh();
    } catch (cause) { setHostedError(cause instanceof Error ? cause.message : t.hostedUnavailable); }
    finally { hostedOperation.current = false; setHostedBusy(false); }
  }
  async function connect(command: CompanionCommand, options: AccountOptions = {}) {
    const operation = ++connectionOperation.current;
    const current = () => operation === connectionOperation.current;
    setConnectionTask(command); setConnectionError('');
    try {
      if (command === 'signIn' && !(await requestDataConsent(ACCOUNT_DATA, { permissions: ['nativeMessaging'] }))) {
        if (current()) setConnectionError(t.companionPermission);
        return;
      }
      if (!(await browser.permissions.contains({ permissions: ['nativeMessaging'] }))) {
        if (current()) { setAccount(previous => ({ ...previous, state: 'signedout' })); setModels([]); setModelsLoaded(false); }
        return;
      }
      await request({ type: 'companion', command, ...options });
    } catch (cause) {
      if (current()) {
        setConnectionError(cause instanceof Error ? cause.message : t.invalidCompanion);
        if (command === 'status' || command === 'signIn') setAccount(previous => previous.state === 'connected' ? previous : { ...previous, state: 'unavailable' });
      }
    } finally { if (current()) setConnectionTask(''); }
  }
  async function chooseModel(model: string) {
    setConnectionTask('model'); setConnectionError('');
    try { await persist({ type: 'set-chatgpt-model', model }); localConfig({ ...configRef.current, model }); }
    catch (cause) { setConnectionError(cause instanceof Error ? cause.message : t.invalidCompanion); }
    finally { setConnectionTask(''); }
  }
  async function inspect() {
    const [active] = await browser.tabs.query({ active: true, currentWindow: true });
    if (!active?.id) throw new Error('Open the product page, then use the Vegsnap toolbar button.');
    const [response] = await browser.scripting.executeScript({ target: { tabId: active.id }, func: () => ({ selection: window.getSelection()?.toString().slice(0, 30_000) ?? '', json: Array.from(document.querySelectorAll('script[type="application/ld+json"]')).slice(0, 10).map(node => (node.textContent ?? '').slice(0, 300_000)), title: document.title }) });
    const page = response?.result;
    if (!page) throw new Error('This page cannot be read. Paste text or import a photo instead.');
    const products = page.json.flatMap(value => { try { return extractProducts(JSON.parse(value)); } catch { return []; } });
    const input = inspectedInput({ ...page, products });
    setText(input.text ?? '');
    setInspectedIdentity(input.name || input.barcode ? { name: input.name, barcode: input.barcode } : undefined);
    setComplete(false);
  }
  async function toggleStore(store: typeof STORES[number], grantAll = false) {
    const enabled = configRef.current.stores.includes(store.id);
    if ((!enabled || grantAll) && !(await requestDataConsent(CONTENT_DATA, { origins: [...store.origins] }))) throw new Error(t.dataConsentDenied);
    await settingsWrites.current;
    const stores = await request<string[]>({ type: 'set-store', store: store.id, enabled: grantAll || !enabled });
    if (enabled && !grantAll) await browser.permissions.remove({ origins: [...store.origins] });
    localConfig({ ...configRef.current, stores });
  }
  async function remoteImage() {
    if (!imageUrl) return;
    const url = new URL(imageUrl);
    if (url.protocol !== 'https:') throw new Error('Save this image and import it as a file.');
    if (!(await requestDataConsent(CONTENT_DATA, { origins: [`${url.protocol}//${url.hostname}/*`] }))) throw new Error(t.dataConsentDenied);
    const response = await contentFetch(url, { credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error('Image could not be loaded. Save it and import the file.');
    setImages([await sanitizeImage(await readImageResponse(response))]); setImageUrl(undefined);
  }
  function exportHistory() {
    const blob = new Blob([JSON.stringify({ schemaVersion: 1, exportedAt: new Date().toISOString(), results: historyExport(savedHistory) }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = 'vegsnap-history.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return <div class={`shell ${isPopup ? 'popup' : ''}`}>
    <header><div class="brand"><img class="brand-icon" src="/icons/vegsnap.svg" alt="" width="44" height="44"/><div><strong>Vegsnap</strong></div></div>{isPopup && <button class="icon-button" title={t.expand} aria-label={t.expand} onClick={() => { void browser.tabs.create({ url: browser.runtime.getURL('/app.html') }); }}>↗</button>}</header>
    <nav aria-label="Vegsnap">{(['scan', 'history', 'settings'] as const).map(name => <button key={name} aria-current={tab === name ? 'page' : undefined} onClick={() => { setTab(name); setResult(undefined); setEditingResult(undefined); setError(''); setNotice(''); }}>{t[name]}{name === 'history' && savedHistory.length > 0 && <span class="count">{savedHistory.length}</span>}</button>)}</nav>
    <main aria-busy={busy}>
      {error && <div role="alert" class="alert error"><strong>{t.error}</strong><p>{error}</p></div>}
      {notice && <p role="status" class="alert">{notice}</p>}
      {busy && (ready || showStartupLoading) && <div class="check-progress"><p role="status" class="working"><span class="spinner" aria-hidden="true"/>{!ready ? t.loadingApp : checkProgress?.stage === 'database' ? t.progressDatabase : checkProgress?.stage === 'ai' ? t.progressAI : checkProgress ? t.progressEvaluating : t.checking}</p>{checkProgress && <><progress aria-label={t.checking}/><span class="hint">{elapsedSeconds}s</span></>}</div>}
      {result ? <section class="result">
        <button class="text-button" onClick={() => setResult(undefined)}>← {t.back}</button>
        <div class={`verdict ${result.outcome}`}><span class="eyebrow">{t.result}</span><h1 ref={resultHeading} tabIndex={-1}>{result.title}</h1><p>{result.summary}</p><div class="result-meta"><span>{result.identity.name ?? result.identity.barcode ?? t[result.category]}</span><span>{t.checked} {new Date(result.checkedAt).toLocaleDateString(config.language)}</span></div></div>
        <button class="edit-details" type="button" disabled={busy} onClick={editResult}>{t.editDetails}</button>
        {result.photos?.length ? <section class="history-photos"><h2>{t.savedPhotos}</h2>{result.photos.map((photo, index) => <details key={index}><summary><img src={photo} alt={`${t.savedPhotos} ${index + 1}`}/><span>{t.previewPhoto}</span></summary><img class="photo-expanded" src={photo} alt={`${t.savedPhotos} ${index + 1}`}/></details>)}</section> : null}
        <p class="muted">{result.aiStatus === 'images' ? t.aiImages : result.aiStatus === 'text' ? t.aiText : result.aiStatus === 'failed' ? t.aiFailed : result.aiStatus === 'unconfigured' ? t.aiUnconfigured : result.aiStatus === 'disabled' ? t.aiDisabled : result.aiStatus === 'vision_disabled' ? t.aiVisionDisabled : result.aiStatus === 'offline' ? t.aiOffline : result.usedAI ? t.ai : t.local}</p>
        {onlineCheck?.id === result.id && <div class="alert"><p>{t.onlineConsentHint}</p><button type="button" disabled={busy} onClick={allowOnlineCheck}>{t.allowOnlineChecks}</button></div>}
        {result.webSearchStatus === 'searched' && <p class="muted">{t.webSearched}</p>}
        {result.webSearchStatus === 'unsupported' && <p class="muted">{t.webUnsupported}</p>}
        {result.findings.length > 0 && <section><h2>{t.findings}</h2>{localizeResult(result, config.language).findings.map((finding, i) => <div class="finding" key={i}><div class="finding-name"><IngredientStatus status={finding.status} language={config.language}/><strong>{finding.displayTerm ?? finding.term}</strong></div>{finding.displayTerm && finding.displayTerm !== finding.term && <small class="hint">{t.originalTerm}: {finding.term}</small>}<p>{finding.explanation}</p></div>)}</section>}
        {[[t.questions, localizeResult(result, config.language).questions], [t.warnings, result.warnings], [t.crossContact, result.crossContact]].map(([title, values]) => Array.isArray(values) && values.length > 0 && <section><h2>{String(title)}</h2><ul>{values.map(value => <li>{value}</li>)}</ul></section>)}
        <section><h2>{t.evidence}</h2>{result.evidence.map(item => <article class="evidence" key={item.id}><strong>{item.title}</strong><p>{item.excerpt}</p><small>{safeLink(item.url) && <a href={safeLink(item.url)} target="_blank" rel="noreferrer">{t.source} ↗</a>} {item.license} · {new Date(item.retrievedAt).toLocaleDateString(config.language)}{item.verification && ` · ${item.verification}`}</small></article>)}</section>
        <ManufacturerContactSection key={result.id} result={result} locale={config.language}/>
        <CommunityRepliesSection result={result} locale={config.language}/>
        <CompanyConcerns assessment={result.companyAssessment} concerns={result.companyConcerns} locale={config.language}/>
      </section> : tab === 'scan' ? <section>
        <h1>{editingResult ? t.editDetails : t.scan}</h1>
        {editingResult && <p class="hint">{t.editDetailsHint}</p>}
        <form onSubmit={event => { event.preventDefault(); void check({ ...scanInput({ text, category, complete, images }), ...inspectedIdentity }); }}>
          {inspectedIdentity && <p class="hint">{inspectedIdentity.name ?? inspectedIdentity.barcode}</p>}
          <label>{t.text}<textarea ref={detailsField} value={text} onInput={event => { setText(event.currentTarget.value); if (!editingResult) setInspectedIdentity(undefined); }} placeholder={t.placeholder} maxLength={30_000} rows={5}/></label>
          {isPopup && !editingResult && <button type="button" class="text-button" disabled={busy} onClick={() => void act(inspect)}>{t.inspect} ↗</button>}
          <div class="form-row"><label>{t.category}<select value={category} onChange={event => setCategory(event.currentTarget.value as Category)}>{(['other', 'food', 'drink', 'cosmetics', 'household', 'clothing', 'shoes'] as const).map(item => <option value={item}>{item === 'other' ? t.auto : t[item]}</option>)}</select></label></div>
          <label class="checkbox"><input type="checkbox" checked={complete} onChange={event => setComplete(event.currentTarget.checked)}/><span>{t.complete}<small>{t.completeHint}</small></span></label>
          {imageUrl && <div class="alert"><p>{t.imageHint}</p><button type="button" onClick={() => void act(remoteImage)} disabled={busy}>{t.loadImage}</button></div>}
          <div class="photos">{images.map((image, index) => <figure><img src={image} alt={`${t.photo} ${index + 1}`}/><button type="button" onClick={() => setImages(images.filter((_, i) => i !== index))}>{t.remove}</button></figure>)}</div>
          <label class="upload">+ {t.photo}<input type="file" accept="image/jpeg,image/png,image/webp" disabled={images.length >= 3 || busy} onChange={event => { const file = event.currentTarget.files?.[0]; if (file) void act(async () => { const image = await sanitizeImage(file); setImages(previous => [...previous, image].slice(0, 3)); }); event.currentTarget.value = ''; }}/></label>
          <p class="hint">{t.photoHint}</p>
          <button class="primary wide" type="submit" disabled={!ready || busy || (!text.trim() && images.length === 0 && !inspectedIdentity?.name && !inspectedIdentity?.barcode)}>{editingResult ? t.checkAgain : t.check} <span aria-hidden="true">→</span></button>
          {editingResult && <button type="button" disabled={busy} onClick={cancelEdit}>{t.cancel}</button>}
          {config.connection !== 'database' && activeModel && <p class="hint" role="status">{imageSupport(activeModel, config.connection === 'chatgpt' ? models.find(model => model.id === config.model) : undefined) === 'supported' ? t.imagesSupported : imageSupport(activeModel, config.connection === 'chatgpt' ? models.find(model => model.id === config.model) : undefined) === 'unsupported' ? t.imagesUnsupported : t.imagesAutomatic}</p>}
          <p class="hint">{t.providerHint}</p>
        </form>
      </section> : tab === 'history' ? <section>
        <div class="section-title"><h1>{t.history}</h1>{savedHistory.length > 0 && <button onClick={exportHistory}>{t.export}</button>}</div>
        {savedHistory.length === 0 ? <div class="empty"><Leaf/><h2>{t.noHistory}</h2><p>{t.noHistoryHint}</p></div> : <><label>{t.search}<input type="search" value={search} onInput={event => setSearch(event.currentTarget.value)}/></label><div class="history-list">{savedHistory.filter(item => `${item.title} ${item.identity.name ?? ''} ${item.identity.barcode ?? ''}`.toLocaleLowerCase().includes(search.toLocaleLowerCase())).map(item => <article key={item.id}><button class="history-item" onClick={() => setResult(item)}><span class={`dot ${item.outcome}`}/>{item.photos?.[0] && <img class="history-thumbnail" src={item.photos[0]} alt=""/>}<span class="history-description"><strong>{item.identity.name ?? item.identity.barcode ?? item.title}</strong><small>{item.title} · {new Date(item.checkedAt).toLocaleDateString(config.language)}</small></span><span aria-hidden="true">›</span></button><button class="history-delete" title={t.delete} aria-label={`${t.delete}: ${item.identity.name ?? item.identity.barcode ?? item.title}`} disabled={busy} onClick={event => { event.stopPropagation(); void act(async () => { await request({ type: 'delete', id: item.id }); await refresh(); }); }}><Trash/></button></article>)}</div><button class="danger" onClick={() => { if (confirm(t.confirmDelete)) void act(async () => { await request({ type: 'delete' }); await refresh(); }); }}>{t.deleteAll}</button></>}
      </section> : <section>
        <h1>{t.settings}</h1>
        <section aria-labelledby="store-heading"><h2 id="store-heading">{t.storeHeading}</h2><p class="hint">{t.storeHint}</p>{STORES.map(store => <div class="store" key={store.id}><div><strong>{store.name}</strong><small>{config.stores.includes(store.id) ? t.storeEnabled : t.storeOff}</small></div><div class="actions">{config.stores.includes(store.id) && storeAccess[store.id] === false && <button disabled={!ready || busy} onClick={() => void act(() => toggleStore(store, true))}>{t.enableAllSites}</button>}<button disabled={!ready || busy} onClick={() => void act(() => toggleStore(store))}>{config.stores.includes(store.id) ? t.disable : t.enable}</button></div></div>)}</section>
        <form onSubmit={event => event.preventDefault()}>
          <label>{t.language}<select disabled={!ready || languageSaving || busy} value={config.language} onChange={event => void changeLanguage(event.currentTarget.value as 'de' | 'en')}><option value="de">Deutsch</option><option value="en">English</option></select></label>
          <label>{t.connection}<select disabled={!ready || busy || Boolean(connectionTask)} value={config.connection} onChange={event => changeConnection(event.currentTarget.value as Connection)}><option value="hosted">{t.hosted}</option><option value="chatgpt">{t.chatgpt}</option><option value="database">{t.database}</option>{Object.keys(PRESETS).map(preset => <option value={preset}>{preset === 'openai' ? 'OpenAI API' : preset === 'openrouter' ? 'OpenRouter' : preset === 'gemini' ? 'Gemini' : preset === 'ollama' ? 'Ollama' : 'Custom'}</option>)}</select></label>
          {config.connection === 'chatgpt' ? <section class="connection" aria-label={t.chatgpt} aria-busy={Boolean(connectionTask)}>
            <div class="connection-heading"><strong>{account.state === 'connected' ? t.connected : account.state === 'checking' ? t.checkingConnection : account.state === 'signedout' ? t.notConnected : t.connectionUnavailable}</strong>{account.state === 'connected' && <span class="connection-badge">ChatGPT</span>}</div>
            {account.state === 'connected' && account.email && <button type="button" class="account-email" aria-label={emailRevealed ? `${t.hideEmail}: ${account.email}` : t.showEmail} aria-pressed={emailRevealed} onClick={() => setEmailRevealed(value => !value)}><span aria-hidden="true" class={emailRevealed ? '' : 'email-obscured'}>{emailRevealed ? account.email : '••••••••@••••••••'}</span><span>{emailRevealed ? t.hideEmail : t.showEmail}</span></button>}
            {connectionTask && <p class="working" role="status"><span class="spinner" aria-hidden="true"/>{connectionTask === 'signIn' ? t.signingIn : connectionTask === 'models' ? t.loadingModels : connectionTask === 'disconnect' ? t.disconnecting : connectionTask === 'removeAccount' ? t.removingAccount : connectionTask === 'model' ? t.savingModel : t.checkingConnection}</p>}
            {connectionError && <div class="alert error" role="alert"><p>{connectionError}</p><button type="button" disabled={Boolean(connectionTask)} onClick={() => void connect(account.state === 'connected' ? 'models' : 'status')}>{t.retry}</button></div>}
            {account.state === 'connected' ? <>
              {modelsLoaded && models.length === 0 && <p role="status">{t.noModels}</p>}
              {models.length > 0 && <label>{t.model}<select disabled={Boolean(connectionTask)} value={models.some(model => model.id === config.model) ? config.model : ''} onChange={event => { if (event.currentTarget.value) void chooseModel(event.currentTarget.value); }}><option value="" disabled>{t.chooseModel}</option>{models.map(model => <option key={model.id} value={model.id}>{model.name}</option>)}</select></label>}
              {modelsLoaded && models.length > 0 && <p class="hint" role="status">{models.some(model => model.id === config.model) ? t.readyToCheck : t.chooseModelHint}</p>}
              <div class="actions"><button type="button" disabled={Boolean(connectionTask)} onClick={() => void connect('models')}>{t.refreshModels}</button><button type="button" disabled={Boolean(connectionTask)} onClick={() => void connect('disconnect')}>{t.disconnect}</button></div>
            </> : <><p class="hint">{t.companionHint}</p><button type="button" class="primary" disabled={!ready || Boolean(connectionTask)} onClick={() => void connect('signIn')}>{t.signIn}</button></>}
            {account.savedAccounts !== undefined && account.savedAccounts.length > 0 && <>
              <details class="saved-accounts"><summary>{account.state === 'connected' ? t.switchAccount : t.savedAccounts} · {account.savedAccounts.length}</summary>
                <button type="button" class="text-button" aria-pressed={emailRevealed} onClick={() => setEmailRevealed(value => !value)}>{emailRevealed ? t.hideEmails : t.showEmails}</button>
                {account.savedAccounts.map((saved, index) => {
                  const label = emailRevealed && saved.email ? `${saved.email} · ${t.savedAccount} ${index + 1}` : `${t.savedAccount} ${index + 1}`;
                  const connected = account.state === 'connected' && account.selectedAccount === saved.id;
                  return <div class="saved-account" key={saved.id}><button class="account-select" type="button" disabled={Boolean(connectionTask) || connected} onClick={() => void connect('signIn', { accountId: saved.id })}><strong>{label}</strong><small>{connected ? t.connected : t.reconnectAccount}</small></button>
                    <button type="button" class="history-delete" disabled={Boolean(connectionTask)} title={t.removeAccount} aria-label={`${t.removeAccount}: ${label}`} onClick={() => { if (confirm(t.confirmRemoveAccount.replace('{account}', label))) void connect('removeAccount', { accountId: saved.id }); }}><Trash/></button></div>;
                })}
              </details>
              <button type="button" disabled={!ready || Boolean(connectionTask)} onClick={() => void connect('signIn', { newAccount: true })}>{t.anotherAccount}</button>
            </>}
            {account.state === 'connected' && account.savedAccounts === undefined && <p class="hint">{t.updateCompanionAccounts}</p>}
          </section> : config.connection === 'hosted' ? <section class="connection" aria-label={t.hosted} aria-busy={hostedBusy}>
            <p class="hint">{t.hostedHint}</p>
            <p role="status">{hosted.enabled === false ? t.hostedUnavailable : hosted.state === 'pending' ? t.hostedPending : hosted.state === 'connected' ? `${t.hostedAllowance}: ${hosted.remaining ?? 0}` : t.notConnected}</p>
            {hostedError && <p class="alert error" role="alert">{hostedError}</p>}
            <div class="actions"><button type="button" disabled={hostedBusy || !ready || hosted.state !== 'connected' && hosted.enabled === false} onClick={() => void connectHosted(hosted.state === 'connected' ? 'status' : 'connect')}>{hosted.state === 'signedout' ? t.hostedConnect : hosted.state === 'pending' ? t.hostedContinue : t.hostedRefresh}</button>
            {hosted.state !== 'signedout' && <button type="button" disabled={hostedBusy} onClick={() => void connectHosted('disconnect')}>{t.disconnect}</button>}</div>
          </section> : config.connection !== 'database' ? <><label>{t.endpoint}<input type="url" required value={config.baseUrl} onInput={event => update('baseUrl', event.currentTarget.value)}/></label><label>{t.token}<input type="password" autoComplete="off" value={token} onInput={event => changeToken(event.currentTarget.value)}/></label><p class="hint">{t.tokenHint} {hasKey ? t.hasKey : t.emptyKey}</p>{hasKey && <button type="button" onClick={() => changeToken('')}>{t.disconnect}</button>}</> : null}
          {!['database', 'chatgpt', 'hosted'].includes(config.connection) && <label>{t.model}<input value={config.model} placeholder="Model ID" onInput={event => update('model', event.currentTarget.value)}/></label>}
          {config.connection !== 'database' && activeModel && <p class="hint" role="status">{imageSupport(activeModel, config.connection === 'chatgpt' ? models.find(model => model.id === config.model) : undefined) === 'supported' ? t.imagesSupported : imageSupport(activeModel, config.connection === 'chatgpt' ? models.find(model => model.id === config.model) : undefined) === 'unsupported' ? t.imagesUnsupported : t.imagesAutomatic}</p>}
          <p class="hint">{t.providerHint}</p>
          <section aria-labelledby="offline-heading"><h2 id="offline-heading">{t.offlineHeading}</h2><p class="hint">{t.offlineHint}</p>
            {offlinePacks.map(pack => <div class="store" key={`${pack.bundled}:${pack.region}`}><div><strong>{pack.region}</strong><small>{pack.count.toLocaleString(config.language)} {t.offlineProducts} · {new Date(pack.generatedAt).toLocaleDateString(config.language)}{pack.bundled ? ` · ${t.offlineBundled}` : ''}</small></div>{!pack.bundled && <button type="button" disabled={busy} onClick={() => void act(async () => { await request({ type: 'remove-offline-pack', region: pack.region }); await refresh(); })}>{t.remove}</button>}</div>)}
            <label class="upload">{t.offlineImport}<input type="file" accept="application/json,.json" disabled={busy} onChange={event => { const file = event.currentTarget.files?.[0]; if (file) void act(async () => { if (file.size > OFFLINE_MAX_BYTES) throw new Error('Offline packs must be no larger than 10 MB.'); await request({ type: 'import-offline-pack', text: await file.text() }); await refresh(); }); event.currentTarget.value = ''; }}/></label>
          </section>
          <h2>{t.privacy}</h2><p class="hint"><a href="https://vegsnap.app/privacy.html" target="_blank" rel="noreferrer">{t.privacyPolicy}</a></p><label class="checkbox"><input type="checkbox" checked={config.saveHistory} onChange={event => update('saveHistory', event.currentTarget.checked)}/>{t.historySetting}</label>
        </form>
        <footer>Vegsnap · AGPL-3.0 · <a href="https://world.openfoodfacts.org" target="_blank" rel="noreferrer">Open Facts / ODbL</a></footer>
      </section>}
      <aside class="mobile-app" aria-labelledby="mobile-app-heading">
        <h2 id="mobile-app-heading">{t.mobileHeading}</h2>
        <p>{t.mobileHint}</p>
        <a class="contact-action" href={`https://vegsnap.app/${config.language === 'de' ? 'de/' : ''}#download`} target="_blank" rel="noreferrer">{t.mobileAction}<span aria-hidden="true">↗</span></a>
      </aside>
    </main>
  </div>;
}
const root = document.getElementById('app');
if (root) render(<App/>, root);
