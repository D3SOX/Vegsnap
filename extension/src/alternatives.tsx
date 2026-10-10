import { useEffect, useRef, useState } from 'preact/hooks';
import { searchPublicAlternatives, rankAlternatives, type AlternativeSearch, type VeganAlternative } from '@vegsnap/core';
import { CONTENT_DATA, ACCOUNT_DATA, AI_DATA, contentFetch, hasDataConsent, requestDataConsent } from './data-consent';
import { endpointOrigin, type Settings } from './settings';
import { HOSTED_AI } from '@vegsnap/core';

export function Alternatives({ config, initialQuery = '', category = 'food', market, excludeBarcode, research, researchEnabled = false }: {
  config: Settings; initialQuery?: string; category?: AlternativeSearch['category']; market: string; excludeBarcode?: string;
  research: (input: AlternativeSearch, signal: AbortSignal) => Promise<VeganAlternative[]>;
  researchEnabled?: boolean;
}) {
  const de = config.language === 'de';
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
    return () => { generation.current++; abort.current?.abort(); };
  }, [market, config.language, config.connection, config.model, config.baseUrl, researchEnabled]);
  async function search(consent: Promise<boolean>, aiConsent: Promise<boolean>) {
    cancel(); const id = ++generation.current, controller = new AbortController(); abort.current = controller;
    const input: AlternativeSearch = { query: query.trim(), store: store.trim(), category: kind, market, locale: config.language, excludeBarcode };
    setBusy(true); setSearched(true); setItems([]); setError(''); setStage(de ? 'Produktdaten werden durchsucht…' : 'Searching public records…');
    let publicItems: VeganAlternative[] = [];
    try {
      if (!(await consent)) throw new Error(de ? 'Datenfreigabe für die Suche erlauben.' : 'Allow data sharing to search.');
      publicItems = await searchPublicAlternatives(input, contentFetch, controller.signal);
      if (id !== generation.current) return;
      setItems(publicItems);
    } catch (e) {
      if (id !== generation.current) return;
      setError(e instanceof Error ? e.message : (de ? 'Suche fehlgeschlagen.' : 'Search failed.'));
    }
    const allowAI = await aiConsent.catch(() => false);
    if (researchEnabled && id === generation.current && allowAI) {
      setStage(de ? 'KI recherchiert Alternativen…' : 'AI is researching alternatives…');
      try {
        const researched = await research(input, controller.signal);
        if (id === generation.current) setItems(rankAlternatives([...publicItems, ...researched], input));
      } catch { if (id === generation.current) setError(de ? 'KI-Recherche nicht verfügbar. Öffentliche Treffer bleiben erhalten.' : 'AI research unavailable. Public matches have been kept.'); }
    }
    if (id === generation.current) setBusy(false);
  }
  return <section aria-busy={busy}>
    <h2>{de ? 'Vegane Alternativen' : 'Vegan alternatives'}</h2>
    <p class="hint">{de ? 'Suche nach einer Produktart, z. B. Schokolade oder Joghurt. Ein Ladenname priorisiert dort gelistete Produkte.' : 'Search a product type, e.g. chocolate or yogurt. Add a store to prioritize products listed there.'}</p>
    <p class="hint">{de ? 'Produktland' : 'Product country'}: {market}</p>
    <form onSubmit={event => {
      event.preventDefault();
      const data = researchEnabled ? config.connection === 'chatgpt' ? [...ACCOUNT_DATA, ...CONTENT_DATA] : AI_DATA : CONTENT_DATA;
      const grant = requestDataConsent(data, researchEnabled && config.connection !== 'chatgpt' ? { origins: [endpointOrigin(config.connection === 'hosted' ? HOSTED_AI.baseUrl : config.baseUrl)] } : {});
      void search(grant.then(allowed => allowed || hasDataConsent(CONTENT_DATA)), researchEnabled ? grant : Promise.resolve(false));
    }}>
      <label>{de ? 'Produkt oder Produktart' : 'Product or product type'}<input value={query} minLength={2} maxLength={200} required disabled={busy} onInput={event => setQuery(event.currentTarget.value)}/></label>
      <label>{de ? 'Ladenname (optional)' : 'Store name (optional)'}<input value={store} maxLength={100} disabled={busy} onInput={event => setStore(event.currentTarget.value)}/></label>
      <label>{de ? 'Kategorie' : 'Category'}<select value={kind} disabled={busy} onChange={event => setKind(event.currentTarget.value as AlternativeSearch['category'])}>{(['food', 'drink', 'cosmetics', 'household', 'clothing', 'shoes', 'other'] as const).map(value => <option value={value}>{({ food: de ? 'Lebensmittel' : 'Food', drink: de ? 'Getränke' : 'Drinks', cosmetics: de ? 'Kosmetik' : 'Cosmetics', household: de ? 'Haushalt' : 'Household', clothing: de ? 'Kleidung' : 'Clothing', shoes: de ? 'Schuhe' : 'Shoes', other: de ? 'Sonstiges' : 'Other' })[value]}</option>)}</select></label>
      <button type="submit" disabled={busy || query.trim().length < 2}>{de ? 'Alternativen suchen' : 'Find alternatives'}</button>
      {busy && <button type="button" onClick={cancel}>{de ? 'Abbrechen' : 'Cancel'}</button>}
    </form>
    {busy && <p role="status" class="working"><span class="spinner" aria-hidden="true"/>{stage}</p>}
    {error && <p role="alert" class="alert error">{error}</p>}
    {searched && !busy && !error && !items.length && <p role="status">{de ? 'Keine belegten Alternativen gefunden. Versuche eine allgemeinere Produktart oder einen anderen Laden.' : 'No supported alternatives found. Try a broader product type or another store.'}</p>}
    {items.map(item => <article class="evidence" key={item.id}>
      <strong>{item.name}</strong>
      {item.brand && <p>{item.brand}</p>}
      <p>{item.storeMatch
        ? (de ? `Bei ${item.stores.join(', ')} gelistet — wahrscheinlich erhältlich` : `Listed at ${item.stores.join(', ')} — likely available`)
        : (de ? 'Verfügbarkeit im Laden unbekannt' : 'Store availability unknown')}</p>
      <p class="hint">{item.source === 'AI'
        ? (de ? 'KI-Recherche — Quelle prüfen' : 'AI research — review the source')
        : `${item.source} · ODbL-1.0 · ${de ? 'Vegan laut Datenbanklabel' : 'Vegan according to database label'}`}
        {!item.marketListed && ` · ${de ? 'Produktland unbestätigt' : 'Product country unconfirmed'}`}</p>
      {item.source === 'AI' && <p>{item.evidence}</p>}
      <a class="alternative-source" href={item.storeUrl ?? item.url} target="_blank" rel="noreferrer">{de ? 'Produktquelle öffnen' : 'Open product source'} ↗</a>
      {item.storeUrl && item.storeUrl !== item.url && <p><a class="alternative-source" href={item.url} target="_blank" rel="noreferrer">{de ? 'Vegan-Beleg' : 'Vegan evidence'} ↗</a></p>}
    </article>)}
    <p class="hint">{de ? 'Gemeinschaftliche Angaben können veraltet sein. Prüfe die aktuelle Packung und den Bestand deiner Filiale. KI-Recherche nutzt die verbundene KI und deren Kontingent; ohne Websuche bleiben öffentliche Treffer.' : 'Community records can be outdated. Check the current package and your branch’s stock. AI research uses your connected provider and allowance; providers without web search keep public results.'}</p>
  </section>;
}
