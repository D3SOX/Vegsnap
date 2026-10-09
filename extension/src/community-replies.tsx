/** @jsxImportSource preact */
import { communityLinks, communityLookupParams, parseCommunityReplyPage, type CheckResult, type CommunityReply, type CommunityReplyPage, type Locale } from '@vegsnap/core';
import { useEffect, useRef, useState } from 'preact/hooks';

const messages = {
  en: { title:'Community manufacturer replies', share:'Share a reply', view:'View shared replies', notice:'Opening a product checks reviewed replies using its barcode, name, brand and country. Whole-product confirmations can update the verdict. Your history and photos stay on this device.', offline:'Go online to share or view community replies.', loading:'Checking manufacturer replies…', failed:'Could not load replies. Retry to check current manufacturer evidence.', missing:'Add the product name and brand or barcode, and country, to find replies.', empty:'No reviewed replies found.', retry:'Refresh replies', candidate:'Possible product range. Confirm that your product belongs to it.', confirm:'This is my product range', reviewed:'Reviewed community contribution; the sender was not independently authenticated.', scope:'Response covers', whole_product:'The whole product', ingredients:'Specific ingredients or materials', processing:'Processing aids / production', permission:'Allow community lookup', permissionHint:'Browser permission is needed before product details can be sent to the community service.', more:'More than 50 replies match. The verdict stays unchanged until all relevant evidence can be checked.' },
  de: { title:'Herstellerantworten aus der Community', share:'Antwort teilen', view:'Geteilte Antworten ansehen', notice:'Beim Öffnen eines Produkts werden geprüfte Antworten anhand von Barcode, Name, Marke und Land gesucht. Bestätigungen für das ganze Produkt können das Ergebnis ändern. Verlauf und Fotos bleiben auf diesem Gerät.', offline:'Gehe online, um Antworten zu teilen oder anzusehen.', loading:'Herstellerantworten werden geprüft…', failed:'Antworten konnten nicht geladen werden. Erneut versuchen, um aktuelle Herstellerbelege zu prüfen.', missing:'Produktname und Marke oder Barcode sowie Land ergänzen, um Antworten zu finden.', empty:'Keine geprüften Antworten gefunden.', retry:'Antworten aktualisieren', candidate:'Mögliche Produktreihe. Bestätige, dass dein Produkt dazugehört.', confirm:'Das ist meine Produktreihe', reviewed:'Geprüfter Community-Beitrag; Absender nicht unabhängig authentifiziert.', scope:'Die Antwort betrifft', whole_product:'Das gesamte Produkt', ingredients:'Bestimmte Zutaten oder Materialien', processing:'Verarbeitungshilfsmittel / Herstellung', permission:'Community-Suche erlauben', permissionHint:'Eine Browserberechtigung ist erforderlich, bevor Produktdetails an den Community-Dienst gesendet werden.', more:'Mehr als 50 Antworten passen. Das Ergebnis bleibt unverändert, bis alle relevanten Belege geprüft werden können.' },
};
const alwaysAllowed = async () => true;
export function CommunityRepliesSection({result,locale,baseUrl,offline = false,onReplies,fetchReplies = fetch,canLookup = alwaysAllowed,allowLookup}: {
  result:CheckResult; locale:Locale; baseUrl?:string; offline?:boolean; onReplies?:(replies:CommunityReply[])=>void;
  fetchReplies?:typeof fetch; canLookup?:()=>Promise<boolean>; allowLookup?:()=>Promise<boolean>;
}) {
  const [networkOffline,setNetworkOffline] = useState(navigator.onLine === false);
  const [page,setPage] = useState<CommunityReplyPage>();
  const [confirmed,setConfirmed] = useState<string[]>([]);
  const [status,setStatus] = useState<'loading'|'failed'|'missing'|'permission'|'ready'>('loading');
  const [revision,setRevision] = useState(0);
  const notify = useRef(onReplies); notify.current = onReplies;
  const lookupAllowed = useRef(canLookup); lookupAllowed.current = canLookup;
  const links = communityLinks(result,locale,baseUrl);
  const identityKey = JSON.stringify(result.identity), disabled = offline || networkOffline;
  const origin = links ? new URL(links.replies).origin : '';
  useEffect(() => {
    const update = () => setNetworkOffline(navigator.onLine === false);
    window.addEventListener('online',update); window.addEventListener('offline',update);
    return () => { window.removeEventListener('online',update); window.removeEventListener('offline',update); };
  },[]);
  useEffect(() => {
    const controller = new AbortController();
    setPage(undefined); setConfirmed([]); notify.current?.([]);
    if (!origin || disabled) return () => controller.abort();
    let params: URLSearchParams;
    try { params = communityLookupParams(result.identity); }
    catch { setStatus('missing'); return () => controller.abort(); }
    setStatus('loading');
    void (async () => {
      try {
        if (!(await lookupAllowed.current())) { if (!controller.signal.aborted) setStatus('permission'); return; }
        if (controller.signal.aborted) return;
        const response = await fetchReplies(`${origin}/api/replies?${params}`,{credentials:'omit',referrerPolicy:'no-referrer',cache:'no-store',redirect:'error',signal:AbortSignal.any([controller.signal,AbortSignal.timeout(20_000)])});
        if (!response.ok) throw new Error('Community lookup failed.');
        const text = await response.text(); if (text.length > 4_000_000) throw new Error('Community response too large.');
        const loaded = parseCommunityReplyPage(JSON.parse(text) as unknown);
        if (!controller.signal.aborted) { setPage(loaded); setStatus('ready'); notify.current?.(loaded.more ? [] : loaded.replies); }
      } catch { if (!controller.signal.aborted) { setStatus('failed'); notify.current?.([]); } }
    })();
    return () => controller.abort();
  },[result.id,identityKey,origin,disabled,revision,fetchReplies]);
  if (!links) return null;
  const t = messages[locale];
  return <section class="manufacturer-contact">
    <h2>{t.title}</h2><p class="muted">{t.notice}</p>
    {disabled ? <p class="hint">{t.offline}</p> : <>
      <div class="actions">
        <a class="contact-action" href={links.submit} target="_blank" rel="noopener noreferrer">{t.share} ↗</a>
        <a class="contact-action" href={links.replies} target="_blank" rel="noopener noreferrer">{t.view} ↗</a>
      </div>
      <div role="status" aria-live="polite">
        {status !== 'ready' && <p class="hint">{status === 'permission' ? t.permissionHint : t[status]}</p>}
        {page?.more && <p class="hint">{t.more}</p>}
        {status === 'ready' && page && !page.replies.length && !page.candidates.length && <p class="hint">{t.empty}</p>}
      </div>
      {status === 'permission' && allowLookup && <button type="button" onClick={()=>{ void allowLookup().then(allowed=>{if(allowed) setRevision(value=>value+1);}); }}>{t.permission}</button>}
      {status !== 'loading' && status !== 'permission' && <button type="button" onClick={()=>setRevision(value=>value+1)}>{t.retry}</button>}
      {page && [...page.replies,...page.candidates].map(reply => <article class="evidence" key={reply.id}>
        <strong>{reply.coverage?.range?.name ?? `${reply.brand} · ${reply.productName}`}</strong>
        <p class="hint">{reply.repliedOn} · {reply.coverage?.markets.join(', ') ?? reply.market} · {t.scope}: {t[reply.scope]}</p>
        {reply.match === 'candidate' && !confirmed.includes(reply.id) && <><p>{t.candidate}</p><button type="button" onClick={()=>{
          const next = [...confirmed,reply.id]; setConfirmed(next);
          notify.current?.(page.more ? [] : [...page.replies,...page.candidates.filter(item=>next.includes(item.id)).map(item=>({...item,match:'name' as const}))]);
        }}>{t.confirm}</button></>}
        <details><summary>{reply.claim === 'vegan' ? 'Vegan' : reply.claim === 'not_vegan' ? (locale === 'de' ? 'Nicht vegan' : 'Not vegan') : (locale === 'de' ? 'Weiterhin unklar' : 'Still inconclusive')}</summary>
          <p>{reply.question}</p><p class="quote">{reply.reply}</p><p class="hint">{t.reviewed}</p>
          {reply.sourceUrl && <a href={reply.sourceUrl} target="_blank" rel="noopener noreferrer">{locale === 'de' ? 'Herstellerquelle' : 'Manufacturer source'}</a>}
          {reply.evidencePublic && <a href={`${origin}/api/evidence/${reply.id}`} target="_blank" rel="noopener noreferrer">{locale === 'de' ? 'Geprüften Nachweis herunterladen' : 'Download reviewed evidence'}</a>}
        </details>
      </article>)}
    </>}
  </section>;
}
