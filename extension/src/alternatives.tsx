import { browser } from 'wxt/browser';
import { useEffect, useRef, useState } from 'preact/hooks';
import { searchPublicAlternatives, rankAlternatives, type AlternativeSearch, type VeganAlternative } from '@vegsnap/core';
import { CONTENT_DATA, ACCOUNT_DATA, AI_DATA, contentFetch, hasDataConsent, requestDataConsent } from './data-consent';
import { endpointOrigin, type Settings } from './settings';
import { HOSTED_AI } from '@vegsnap/core';
import { alternativeMessages } from './i18n';

export function Alternatives({ config, initialQuery = '', category = 'food', market, excludeBarcode, research, researchEnabled = false }: {
  config: Settings; initialQuery?: string; category?: AlternativeSearch['category']; market: string; excludeBarcode?: string;
  research: (input: AlternativeSearch, signal: AbortSignal) => Promise<VeganAlternative[]>;
  researchEnabled?: boolean;
}) {
  const t = alternativeMessages[config.language];
  const [query, setQuery] = useState(initialQuery.slice(0, 200));
  const [store, setStore] = useState('');
  const [kind, setKind] = useState(category);
  const [items, setItems] = useState<VeganAlternative[]>([]);
  const [busy, setBusy] = useState(false);
  const [searched, setSearched] = useState(false);
  const [error, setError] = useState('');
  const [stage, setStage] = useState('');
  const generation = useRef(0), abort = useRef<AbortController>();
  const cancel = () => { generation.current++; abort.current?.abort(); setBusy(false); };
  useEffect(() => {
    cancel(); setItems([]); setSearched(false); setError('');
    const permissionRemoved = () => cancel();
    browser.permissions.onRemoved.addListener(permissionRemoved);
    return () => {
      browser.permissions.onRemoved.removeListener(permissionRemoved);
      generation.current++; abort.current?.abort();
    };
  }, [market, config.language, config.connection, config.model, config.baseUrl, researchEnabled]);
  async function search(consent: Promise<boolean>, aiConsent: Promise<boolean>) {
    cancel(); const id = ++generation.current, controller = new AbortController(); abort.current = controller;
    const input: AlternativeSearch = { query: query.trim(), store: store.trim(), category: kind, market, locale: config.language, excludeBarcode };
    setBusy(true); setSearched(true); setItems([]); setError(''); setStage(t.loading);
    let publicItems: VeganAlternative[] = [];
    try {
      if (!(await consent)) throw new Error(t.consentRequired);
      publicItems = await searchPublicAlternatives(input, contentFetch, controller.signal);
      if (id !== generation.current) return;
      setItems(publicItems);
    } catch (e) {
      if (id !== generation.current) return;
      setError(e instanceof Error ? e.message : t.searchFailed);
    }
    const allowAI = await aiConsent.catch(() => false);
    if (researchEnabled && id === generation.current && allowAI) {
      setStage(t.aiLoading);
      try {
        const researched = await research(input, controller.signal);
        if (id === generation.current) setItems(rankAlternatives([...publicItems, ...researched], input));
      } catch { if (id === generation.current) setError(t.aiFailed); }
    }
    if (id === generation.current) setBusy(false);
  }
  return <section aria-busy={busy}>
    <h2>{t.title}</h2>
    <p class="hint">{t.hint}</p>
    <p class="hint">{t.productCountry}: {market}</p>
    <form onSubmit={event => {
      event.preventDefault();
      const data = researchEnabled ? config.connection === 'chatgpt' ? [...ACCOUNT_DATA, ...CONTENT_DATA] : AI_DATA : CONTENT_DATA;
      const grant = requestDataConsent(data, researchEnabled && config.connection !== 'chatgpt' ? { origins: [endpointOrigin(config.connection === 'hosted' ? HOSTED_AI.baseUrl : config.baseUrl)] } : {});
      void search(grant.then(allowed => allowed || hasDataConsent(CONTENT_DATA)), researchEnabled ? grant : Promise.resolve(false));
    }}>
      <label>{t.query}<input value={query} minLength={2} maxLength={200} required disabled={busy} onInput={event => setQuery(event.currentTarget.value)}/></label>
      <label>{t.store}<input value={store} maxLength={100} disabled={busy} onInput={event => setStore(event.currentTarget.value)}/></label>
      <label>{t.category}<select value={kind} disabled={busy} onChange={event => setKind(event.currentTarget.value as AlternativeSearch['category'])}>{(['food', 'drink', 'cosmetics', 'household', 'clothing', 'shoes', 'other'] as const).map(value => <option value={value}>{({ food: t.food, drink: t.drinks, cosmetics: t.cosmetics, household: t.household, clothing: t.clothing, shoes: t.shoes, other: t.other })[value]}</option>)}</select></label>
      <button type="submit" disabled={busy || query.trim().length < 2}>{t.search}</button>
      {busy && <button type="button" onClick={cancel}>{t.cancel}</button>}
    </form>
    {busy && <p role="status" class="working"><span class="spinner" aria-hidden="true"/>{stage}</p>}
    {error && <p role="alert" class="alert error">{error}</p>}
    {searched && !busy && !error && !items.length && <p role="status">{t.empty}</p>}
    {items.map(item => <article class="evidence" key={item.id}>
      <strong>{item.name}</strong>
      {item.brand && <p>{item.brand}</p>}
      <p>{item.storeMatch
        ? (t.storeMatch.replace('{stores}', item.stores.join(', ')))
        : t.storeUnknown}</p>
      <p class="hint">{item.source === 'AI'
        ? t.aiSource
        : `${item.source} · ODbL-1.0 · ${t.databaseLabel}`}
        {!item.marketListed && ` · ${t.countryUnknown}`}</p>
      {item.source === 'AI' && <p>{item.evidence}</p>}
      <a class="alternative-source" href={item.storeUrl ?? item.url} target="_blank" rel="noreferrer">{t.source} ↗</a>
      {item.storeUrl && item.storeUrl !== item.url && <p><a class="alternative-source" href={item.url} target="_blank" rel="noreferrer">{t.veganEvidence} ↗</a></p>}
    </article>)}
    <p class="hint">{t.disclaimer}</p>
  </section>;
}
