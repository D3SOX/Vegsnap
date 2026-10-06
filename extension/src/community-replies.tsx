/** @jsxImportSource preact */
import { communityLinks, type CheckResult, type Locale } from '@vegsnap/core';
import { useEffect, useState } from 'preact/hooks';

const messages = {
  en: { title:'Community manufacturer replies', share:'Share a reply', view:'View shared replies', notice:'Have a manufacturer response? Share it for review. Only what you submit in the form is uploaded. Reviewed replies do not change this result.', offline:'Go online to share or view community replies.' },
  de: { title:'Herstellerantworten aus der Community', share:'Antwort teilen', view:'Geteilte Antworten ansehen', notice:'Hast du eine Herstellerantwort? Reiche sie zur Prüfung ein. Nur deine Angaben im Formular werden übertragen. Geprüfte Antworten ändern dieses Ergebnis nicht.', offline:'Gehe online, um Antworten zu teilen oder anzusehen.' },
};
export function CommunityRepliesSection({result,locale,baseUrl}: {result:CheckResult;locale:Locale;baseUrl?:string}) {
  const [offline,setOffline] = useState(navigator.onLine === false);
  useEffect(() => {
    const update = () => setOffline(navigator.onLine === false);
    window.addEventListener('online',update); window.addEventListener('offline',update);
    return () => { window.removeEventListener('online',update); window.removeEventListener('offline',update); };
  },[]);
  const links = communityLinks(result,locale,baseUrl);
  if (!links) return null;
  const t = messages[locale];
  return <section class="manufacturer-contact">
    <h2>{t.title}</h2><p class="muted">{t.notice}</p>
    {offline ? <p class="hint">{t.offline}</p> : <div class="actions">
      <a class="contact-action" href={links.submit} target="_blank" rel="noopener noreferrer">{t.share} ↗</a>
      <a class="contact-action" href={links.replies} target="_blank" rel="noopener noreferrer">{t.view} ↗</a>
    </div>}
  </section>;
}
