/** @jsxImportSource preact */
import { useState } from 'preact/hooks';
import { manufacturerMessage, manufacturerMessageLanguages, parseManufacturerContact, type CheckResult, type Locale, type ManufacturerMessageLanguage } from '@vegsnap/core';

const messages = {
  en: { title: 'Ask the manufacturer', source: 'Contact source', caution: 'AI read these contact details from the linked source. Check them before sending.', missing: 'Contact details were not found for this check. Copy the message and find a contact on the manufacturer’s official website.', review: 'Review message', subject: 'Subject', copy: 'Copy message', copied: 'Message copied.', failed: 'Could not copy. Select the message below and copy it manually.', email: 'Open in email app', form: 'Open contact form', note: 'You review and send the message yourself.' },
  de: { title: 'Beim Hersteller nachfragen', source: 'Quelle der Kontaktdaten', caution: 'KI hat diese Kontaktdaten aus der verlinkten Quelle gelesen. Prüfe sie vor dem Senden.', missing: 'Für diese Prüfung wurden keine Kontaktdaten gefunden. Kopiere die Nachricht und suche einen Kontakt auf der offiziellen Website des Herstellers.', review: 'Nachricht prüfen', subject: 'Betreff', copy: 'Nachricht kopieren', copied: 'Nachricht kopiert.', failed: 'Kopieren nicht möglich. Markiere die Nachricht unten und kopiere sie manuell.', email: 'In E-Mail-App öffnen', form: 'Kontaktformular öffnen', note: 'Du prüfst und sendest die Nachricht selbst.' },
};
export function ManufacturerContactSection({ result, locale }: { result: CheckResult; locale: Locale }) {
  const [draftLanguage, setDraftLanguage] = useState<ManufacturerMessageLanguage>(locale);
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  const contact = parseManufacturerContact(result.manufacturerContact);
  const draft = manufacturerMessage(result, draftLanguage);
  if (!draft) return null;
  const t = messages[locale];
  const text = `${draft.subject}\n\n${draft.body}`;
  async function copy() {
    setCopied(false); setFailed(false);
    try { await navigator.clipboard.writeText(text); setCopied(true); }
    catch { setFailed(true); }
  }
  return <section class="manufacturer-contact">
    <h2>{t.title}</h2>
    {contact ? <p class="muted">{t.caution} <a href={contact.sourceUrl} target="_blank" rel="noopener noreferrer">{t.source} ↗</a></p> : <p class="muted">{t.missing}</p>}
    {contact?.email && <p class="contact-email">{contact.email}</p>}
    <label class="manufacturer-message-language">{locale === 'de' ? 'Nachrichtensprache' : 'Message language'}
      <select value={draftLanguage} onChange={event => {
        const language = event.currentTarget.value;
        if (language !== 'en' && language !== 'de' && language !== 'sv') return;
        setDraftLanguage(language); setCopied(false); setFailed(false); setExpanded(true);
      }}>{manufacturerMessageLanguages.map(language => <option key={language} value={language}>{{ en: 'English', de: 'Deutsch', sv: 'Svenska' }[language]}</option>)}</select>
    </label>
    <details open={expanded || failed} onToggle={event => setExpanded(event.currentTarget.open)}>
      <summary>{t.review}</summary>
      <textarea aria-label={t.review} lang={draftLanguage} value={text} readOnly rows={10}/>
    </details>
    <div class="actions">
      <button type="button" onClick={() => { void copy(); }}>{t.copy}</button>
      {draft.mailto && <a class="contact-action" href={draft.mailto}>{t.email}</a>}
      {contact?.url && <a class="contact-action" href={contact.url} target="_blank" rel="noopener noreferrer">{t.form} ↗</a>}
    </div>
    {copied && <p role="status" class="hint">{t.copied}</p>}
    {failed && <p role="alert" class="hint">{t.failed}</p>}
    <p class="muted">{t.note}</p>
  </section>;
}
