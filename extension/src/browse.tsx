import { browser } from 'wxt/browser';
import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { DATABASES, PublicSearchError, browseCheckInput, searchBrowse, type BrowsePage, type BrowseSearch, type BrowseSource, type CheckInput } from '@vegsnap/core';
import { CONTENT_DATA, contentFetch, requestDataConsent } from './data-consent';
import type { Settings } from './settings';
import { browseMessages } from './i18n';

/** Submitted searches against one public database; the packs stored on this device answer while it is unreachable. */
export function Browse({ config, offlineSearch, onUse, children }: {
  config: Settings; offlineSearch: (input: BrowseSearch) => Promise<BrowsePage>; onUse: (input: CheckInput) => void; children?: ComponentChildren;
}) {
  const t = browseMessages[config.language];
  const [source, setSource] = useState<BrowseSource>('off');
  const [query, setQuery] = useState('');
  const [submitted, setSubmitted] = useState('');
  const [cursor, setCursor] = useState(0);
  const [page, setPage] = useState<BrowsePage>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const generation = useRef(0), abort = useRef<AbortController | undefined>(undefined);
  const cancel = () => { generation.current++; abort.current?.abort(); setBusy(false); };
  useEffect(() => {
    cancel(); setPage(undefined); setError('');
    const permissionRemoved = () => cancel();
    browser.permissions.onRemoved.addListener(permissionRemoved);
    return () => { browser.permissions.onRemoved.removeListener(permissionRemoved); generation.current++; abort.current?.abort(); };
  }, [source, config.language]);
  async function search(target: number, consent: Promise<boolean>) {
    const term = target === 0 ? query.trim() : submitted;
    if (term.length < 2) return;
    cancel(); const id = ++generation.current, controller = new AbortController(); abort.current = controller;
    const input: BrowseSearch = { source, query: term, cursor: target, locale: config.language };
    setBusy(true); setError('');
    let result: BrowsePage | undefined;
    try {
      if (!(await consent)) throw new Error(t.consentRequired);
      result = await searchBrowse(input, contentFetch, controller.signal);
    } catch (cause) {
      if (id !== generation.current) return;
      const reason = cause instanceof PublicSearchError ? cause.reason : undefined;
      setError(reason === 'rate_limited' ? t.rateLimited : reason === 'temporarily_unavailable' ? t.temporarilyUnavailable : reason === 'timeout' ? t.timeout
        : reason === 'connection' ? t.connectionError : reason === 'unavailable' ? t.error : cause instanceof Error ? cause.message : t.error);
      // While the database is unreachable, slow or down, or data sharing is declined, the bundled and
      // imported packs answer instead. Deliberate responses such as a rate limit do not.
      if (reason === undefined || reason === 'connection' || reason === 'timeout' || reason === 'temporarily_unavailable') result = await offlineSearch(input).catch(() => undefined);
    }
    if (id !== generation.current) return;
    if (result) { setPage(result); setSubmitted(term); setCursor(target); }
    setBusy(false);
  }
  const paging = (target: number) => { void search(target, requestDataConsent(CONTENT_DATA)); };
  const sourceName = (id: BrowseSource) => DATABASES.find(db => db.id === id)?.name ?? id;
  return <section aria-busy={busy}>
    <h1>{t.title}</h1>
    {children}
    <form onSubmit={event => { event.preventDefault(); paging(0); }}>
      <label>{t.source}<select value={source} disabled={busy} onChange={event => setSource(event.currentTarget.value as BrowseSource)}>{DATABASES.map(db => <option key={db.id} value={db.id}>{db.name}</option>)}</select></label>
      <label>{t.query}<input type="search" value={query} minLength={2} maxLength={200} required disabled={busy} onInput={event => setQuery(event.currentTarget.value)}/></label>
      <button type="submit" disabled={busy || query.trim().length < 2}>{t.search}</button>
      {busy && <button type="button" onClick={cancel}>{t.cancel}</button>}
    </form>
    {busy && <p role="status" class="working"><span class="spinner" aria-hidden="true"/>{t.loading}</p>}
    {error && <p role="alert" class="alert error">{error}</p>}
    <p class="hint">{t.communityNotice}</p>
    {page && <section>
      <h2>{t.resultsFor.replace('{query}', submitted)}</h2>
      {page.offline && <p class="hint">{t.offlineNotice}</p>}
      {!page.records.length && <p role="status">{page.offline ? t.offlineEmpty : t.empty}</p>}
      {page.records.map(record => <details class="evidence browse-record" key={`${record.source}:${record.id}`}>
        <summary><strong>{record.name}</strong>{record.brand && <small>{record.brand}</small>}{(record.quantity || record.markets) && <small>{[record.quantity, record.markets].filter(Boolean).join(' · ')}</small>}<small>{sourceName(record.source)} · ODbL-1.0</small></summary>
        <dl>{([[t.brand, record.brand], [t.barcode, record.barcode], [t.markets, record.markets], [t.quantity, record.quantity], [t.labels, record.labels], [t.composition, record.composition || t.noComposition], [t.updated, record.updated]] as const)
          .filter(([, value]) => value).map(([label, value]) => <><dt>{label}</dt><dd>{value}</dd></>)}</dl>
        {record.snapshotDate && <p class="hint">{t.snapshotDate.replace('{date}', record.snapshotDate.slice(0, 10))}</p>}
        <div class="actions"><button type="button" class="primary" onClick={() => onUse(browseCheckInput(record))}>{t.useInScan}</button><a class="alternative-source" href={record.url} target="_blank" rel="noreferrer">{t.sourcePage} ↗</a></div>
      </details>)}
      <div class="browse-pages"><button type="button" disabled={busy || cursor === 0} onClick={() => paging(cursor - 1)}>{t.previous}</button><span class="muted">{t.page.replace('{page}', String(cursor + 1))}</span><button type="button" disabled={busy || page.next === undefined} onClick={() => { if (page.next !== undefined) paging(page.next); }}>{t.next}</button></div>
    </section>}
  </section>;
}
