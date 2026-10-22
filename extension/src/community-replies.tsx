/** @jsxImportSource preact */
import { communityLinks, communityLookupParams, parseCommunityReplyPage, type CheckResult, type CommunityReply, type CommunityReplyPage, type Locale } from '@vegsnap/core';
import { useEffect, useRef, useState } from 'preact/hooks';
import { ContentReportButton } from './content-report';
import { communityMessages as messages } from './i18n';

const alwaysAllowed = async () => true;
const none: string[] = [];
export function CommunityRepliesSection({result,locale,baseUrl,offline = false,onReplies,fetchReplies = fetch,canLookup = alwaysAllowed,allowLookup,hiddenReplies = none,onHideReply}: {
  result:CheckResult; locale:Locale; baseUrl?:string; offline?:boolean; onReplies?:(replies:CommunityReply[], complete:boolean)=>void;
  fetchReplies?:typeof fetch; canLookup?:()=>Promise<boolean>; allowLookup?:()=>Promise<boolean>; hiddenReplies?:string[]; onHideReply?:(id:string)=>void;
}) {
  const [networkOffline,setNetworkOffline] = useState(navigator.onLine === false);
  const [page,setPage] = useState<CommunityReplyPage>();
  const [confirmed,setConfirmed] = useState<string[]>([]);
  const [status,setStatus] = useState<'loading'|'failed'|'missing'|'permission'|'ready'>('loading');
  const [revision,setRevision] = useState(0);
  const notify = useRef(onReplies); notify.current = onReplies;
  const lookupAllowed = useRef(canLookup); lookupAllowed.current = canLookup;
  const links = communityLinks(result,locale,baseUrl);
  const identityKey = JSON.stringify(result.identity), disabled = offline || networkOffline, hiddenKey = hiddenReplies.join(',');
  const origin = links ? new URL(links.replies).origin : '';
  useEffect(() => {
    const update = () => setNetworkOffline(navigator.onLine === false);
    window.addEventListener('online',update); window.addEventListener('offline',update);
    return () => { window.removeEventListener('online',update); window.removeEventListener('offline',update); };
  },[]);
  useEffect(() => {
    const controller = new AbortController();
    setPage(undefined); setConfirmed([]);
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
        if (!controller.signal.aborted) { setPage(loaded); setStatus('ready'); }
      } catch { if (!controller.signal.aborted) setStatus('failed'); }
    })();
    return () => controller.abort();
  },[result.id,identityKey,origin,disabled,revision,fetchReplies,locale]);
  // Replies hidden on this device never reach the verdict; confirmed range suggestions count as named matches.
  useEffect(() => {
    const complete = !!page && !page.more;
    notify.current?.(page && complete ? [...page.replies,...page.candidates.filter(item=>confirmed.includes(item.id)).map(item=>({...item,match:'name' as const}))]
      .filter(item=>!hiddenReplies.includes(item.id)) : [],complete);
  },[page,confirmed,hiddenKey]);
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
      {page && [...page.replies,...page.candidates].filter(reply=>!hiddenReplies.includes(reply.id)).map(reply => <article class="evidence" key={reply.id}>
        <strong>{reply.coverage?.range?.name ?? `${reply.brand} · ${reply.productName}`}</strong>
        <p class="hint">{reply.repliedOn} · {reply.coverage?.markets.join(', ') ?? reply.market} · {t.scope}: {t[reply.scope]}</p>
        {reply.match === 'candidate' && !confirmed.includes(reply.id) && <><p>{t.candidate}</p><button type="button" onClick={()=>setConfirmed(current=>[...current,reply.id])}>{t.confirm}</button></>}
        <details><summary>{reply.claim === 'vegan' ? t.claimVegan : reply.claim === 'not_vegan' ? t.claimNotVegan : t.claimInconclusive}</summary>
          <p>{reply.question}</p><p class="quote">{reply.reply}</p><p class="hint">{t.reviewed}</p>
          {reply.sourceUrl && <a href={reply.sourceUrl} target="_blank" rel="noopener noreferrer">{t.manufacturerSource}</a>}
          {reply.evidencePublic && <a href={`${origin}/api/evidence/${reply.id}`} target="_blank" rel="noopener noreferrer">{t.downloadEvidence}</a>}
        </details>
        <div class="actions">
          <ContentReportButton kind="community" locale={locale} origin={origin} contentId={reply.id} offline={disabled} send={fetchReplies} allowSend={allowLookup}/>
          {onHideReply && <button type="button" onClick={()=>onHideReply(reply.id)}>{t.hideReply}</button>}
        </div>
      </article>)}
      {hiddenReplies.length > 0 && <p class="hint">{t.hiddenNotice}</p>}
    </>}
  </section>;
}
