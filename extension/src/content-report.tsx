/** @jsxImportSource preact */
import { validateContentReport, type CheckResult, type ContentReport, type Locale, type ReportKind, type ResultReport } from '@vegsnap/core';
import { useEffect, useRef, useState } from 'preact/hooks';
import { reportMessages } from './i18n';

const RECEIPT = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const alwaysAllowed = async () => true;
/** The AI text offered for review: summary, explanations and company assessment, never photos or credentials. */
export function aiReportText(result: Pick<CheckResult, 'summary' | 'findings' | 'companyAssessment'>): string {
  return [result.summary, ...result.findings.map(finding => finding.explanation), result.companyAssessment?.summary ?? ''].filter(Boolean).join('\n');
}
/** Mirrors the Android and iOS report dialogs: only reviewed text or verdict context plus the reason leave the device. */
export function ContentReportButton({ kind, locale, origin, contentId = '', initialText = '', result, offline = false, send = fetch, allowSend = alwaysAllowed }: {
  kind: ReportKind; locale: Locale; origin: string; contentId?: string; initialText?: string; result?: ResultReport; offline?: boolean;
  send?: typeof fetch; allowSend?: () => Promise<boolean>;
}) {
  const t = reportMessages[locale];
  const [networkOffline, setNetworkOffline] = useState(navigator.onLine === false);
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [reason, setReason] = useState('');
  const [status, setStatus] = useState<'idle' | 'sending' | 'failed' | 'permission'>('idle');
  const [receipt, setReceipt] = useState('');
  const request = useRef<AbortController | undefined>(undefined);
  const disabled = offline || networkOffline;
  const cancel = () => { request.current?.abort(); request.current = undefined; };
  useEffect(() => {
    const update = () => setNetworkOffline(navigator.onLine === false);
    window.addEventListener('online', update); window.addEventListener('offline', update);
    return () => { cancel(); window.removeEventListener('online', update); window.removeEventListener('offline', update); };
  }, []);
  useEffect(() => { if (disabled) { cancel(); setStatus(current => current === 'sending' ? 'idle' : current); } }, [disabled]);
  const title = kind === 'ai' ? t.ai : kind === 'community' ? t.reply : t.result;
  const draft = (): ContentReport => ({ kind, contentId, text: kind === 'ai' ? text : '', reason, ...(kind === 'result' && result ? { result } : {}) });
  let valid = true;
  try { validateContentReport(draft()); } catch { valid = false; }
  function submit(event: Event) {
    event.preventDefault();
    if (disabled || !valid || status === 'sending') return;
    // Ask for Firefox data consent inside the click handler so the user gesture is retained.
    const consent = allowSend();
    cancel();
    const controller = new AbortController(); request.current = controller;
    setStatus('sending');
    void (async () => {
      try {
        if (!(await consent)) { if (!controller.signal.aborted) setStatus('permission'); return; }
        const response = await send(`${origin}/api/reports`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(validateContentReport(draft())),
          credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store', redirect: 'error', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]) });
        if (response.status !== 201) throw new Error('The report was not accepted.');
        const body = await response.text();
        if (body.length > 4096) throw new Error('Report response too large.');
        const value: unknown = JSON.parse(body);
        if (!value || typeof value !== 'object' || !('id' in value) || typeof value.id !== 'string' || !RECEIPT.test(value.id)) throw new Error('The report was not confirmed.');
        if (!controller.signal.aborted) { setReceipt(value.id); setStatus('idle'); }
      } catch { if (!controller.signal.aborted) setStatus('failed'); }
      finally { if (request.current === controller) request.current = undefined; }
    })();
  }
  return <div class="report">
    <button type="button" disabled={disabled} onClick={() => { cancel(); setText(initialText.slice(0, 8000)); setReason(''); setReceipt(''); setStatus('idle'); setOpen(true); }}>{title}</button>
    {open && <form class="report-form" aria-label={title} onSubmit={submit}>
      {receipt ? <p role="status">{t.sent} {receipt}</p> : <>
        <p class="hint">{kind === 'ai' ? t.aiNotice : kind === 'community' ? t.replyNotice : t.resultNotice}</p>
        {kind === 'ai' && <label>{t.text}<textarea rows={5} maxLength={8000} value={text} disabled={status === 'sending'} onInput={event => setText(event.currentTarget.value)}/></label>}
        <label>{kind === 'result' ? t.resultReason : t.reason}<textarea rows={3} maxLength={2000} value={reason} disabled={status === 'sending'} onInput={event => setReason(event.currentTarget.value)}/></label>
        <div role="status" aria-live="polite">
          {disabled && <p class="hint">{t.offline}</p>}
          {status === 'failed' && <p class="error">{t.failed}</p>}
          {status === 'permission' && <p class="hint">{t.permission}</p>}
        </div>
      </>}
      <div class="actions">
        {!receipt && <button type="submit" class="primary" disabled={disabled || !valid || status === 'sending'}>{status === 'sending' ? t.sending : t.send}</button>}
        <button type="button" onClick={() => { cancel(); setOpen(false); }}>{receipt ? t.close : t.cancel}</button>
      </div>
    </form>}
  </div>;
}
