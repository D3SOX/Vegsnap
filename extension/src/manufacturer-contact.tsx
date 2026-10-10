/** @jsxImportSource preact */
import { useState } from 'preact/hooks';
import { manufacturerMessage, manufacturerMessageLanguages, parseManufacturerContact, type CheckResult, type Locale, type ManufacturerMessageLanguage } from '@vegsnap/core';
import { contactMessages as messages } from './i18n';

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
    <label class="manufacturer-message-language">{t.language}
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
