/** @jsxImportSource preact */
import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { analyzeText, resultReport } from '@vegsnap/core';
import { ContentReportButton, aiReportText } from '../src/content-report';

const receipt = '12345678-1234-4234-8234-123456789abc';
function browserWindow() {
  const window = new Window(); const document = window.document as unknown as Document;
  const previous = { window: globalThis.window, document: globalThis.document, navigator: globalThis.navigator };
  Object.assign(globalThis, { window, document }); Object.defineProperty(globalThis, 'navigator', { configurable: true, value: window.navigator });
  const host = document.createElement('div'); document.body.append(host);
  return { window, host, restore: async () => { await act(() => render(null, host)); Object.assign(globalThis, { window: previous.window, document: previous.document }); Object.defineProperty(globalThis, 'navigator', { configurable: true, value: previous.navigator }); window.close(); } };
}
const flush = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
const button = (host: HTMLElement, text: string) => [...host.querySelectorAll('button')].find(item => item.textContent === text);
async function type(window: Window, field: HTMLTextAreaElement, value: string) { await act(() => { field.value = value; field.dispatchEvent(new window.Event('input', { bubbles: true }) as unknown as Event); }); }
function recorder(status = 201) {
  const requests: { url: string; options: RequestInit }[] = [];
  const send = Object.assign(async (url: RequestInfo | URL, options?: RequestInit) => { requests.push({ url: String(url), options: options ?? {} }); return new Response(JSON.stringify({ id: receipt }), { status }); }, { preconnect: fetch.preconnect }) as typeof fetch;
  return { requests, send };
}

test('wrong-result reports send only the verdict context and the reason after explicit confirmation', async () => {
  const { window, host, restore } = browserWindow();
  const { requests, send } = recorder();
  const result = { ...analyzeText({ text: 'Ingredients: milk, oats', name: 'Oat drink', brand: 'Maker', barcode: '3017620422003' }), photos: ['private-photo'] };
  const details = resultReport(result, { locale: 'en', platform: 'extension', appVersion: '1.2.3' });
  try {
    await act(() => render(<ContentReportButton kind="result" locale="en" origin="https://community.example" result={details} send={send}/>, host));
    await act(() => button(host, 'Report wrong result')!.click());
    expect(host.textContent).toContain('Only this result’s verdict');
    expect(button(host, 'Send report')!.disabled).toBe(true);
    await type(window, host.querySelector('textarea')!, ' Milk here is a plant drink ');
    expect(button(host, 'Send report')!.disabled).toBe(false);
    expect(requests).toHaveLength(0);
    await act(() => button(host, 'Send report')!.click()); await flush();
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe('https://community.example/api/reports');
    expect(requests[0]!.options).toMatchObject({ method: 'POST', credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error' });
    const body = String(requests[0]!.options.body);
    expect(JSON.parse(body)).toEqual({ kind: 'result', contentId: '', text: '', reason: 'Milk here is a plant drink', result: details });
    for (const secret of ['private-photo', 'explanation', 'evidence', '3017620422003']) expect(body).not.toContain(secret);
    expect(host.textContent).toContain(`Report sent. Reference: ${receipt}`);
    await act(() => button(host, 'Close')!.click());
    expect(host.querySelector('form')).toBeNull();
    expect(aiReportText(result)).toContain(result.summary); expect(aiReportText(result)).not.toContain('private-photo');
  } finally { await restore(); }
});

test('AI reports send the edited excerpt, community reports only the reference, and failures stay editable', async () => {
  const { window, host, restore } = browserWindow();
  let status = 503;
  const requests: string[] = [];
  const send = Object.assign(async (_url: RequestInfo | URL, options?: RequestInit) => { requests.push(String(options?.body)); return new Response(status === 201 ? JSON.stringify({ id: receipt }) : '', { status }); }, { preconnect: fetch.preconnect }) as typeof fetch;
  try {
    await act(() => render(<ContentReportButton kind="ai" locale="en" origin="https://community.example" initialText="Private excerpt with name" send={send}/>, host));
    await act(() => button(host, 'Report AI output')!.click());
    const [text, reason] = [...host.querySelectorAll('textarea')] as HTMLTextAreaElement[];
    expect(text!.value).toBe('Private excerpt with name');
    await type(window, text!, 'Redacted excerpt'); await type(window, reason!, 'Misleading');
    await act(() => button(host, 'Send report')!.click()); await flush();
    expect(host.textContent).toContain('Could not send the report');
    expect(button(host, 'Send report')!.disabled).toBe(false);
    status = 201;
    await act(() => button(host, 'Send report')!.click()); await flush();
    expect(requests).toHaveLength(2);
    expect(JSON.parse(requests[1]!)).toEqual({ kind: 'ai', contentId: '', text: 'Redacted excerpt', reason: 'Misleading' });
    expect(host.textContent).toContain(receipt);
    await act(() => render(<ContentReportButton kind="community" locale="de" origin="https://community.example" contentId={receipt} send={send}/>, host));
    await act(() => button(host, 'Diese Antwort melden')!.click());
    expect(host.querySelectorAll('textarea')).toHaveLength(1);
    await type(window, host.querySelector('textarea')!, 'Persönliche Daten');
    await act(() => button(host, 'Meldung senden')!.click()); await flush();
    expect(JSON.parse(requests[2]!)).toEqual({ kind: 'community', contentId: receipt, text: '', reason: 'Persönliche Daten' });
  } finally { await restore(); }
});

test('denied browser consent and offline state never send a report', async () => {
  const { window, host, restore } = browserWindow();
  const { requests, send } = recorder();
  let allowed = false;
  try {
    await act(() => render(<ContentReportButton kind="community" locale="en" origin="https://community.example" contentId={receipt} send={send} allowSend={async () => allowed}/>, host));
    await act(() => button(host, 'Report this reply')!.click());
    await type(window, host.querySelector('textarea')!, 'Harassment');
    await act(() => button(host, 'Send report')!.click()); await flush();
    expect(requests).toHaveLength(0);
    expect(host.textContent).toContain('Browser permission is needed before a report can be sent');
    Object.defineProperty(window.navigator, 'onLine', { configurable: true, value: false });
    await act(() => { window.dispatchEvent(new window.Event('offline')); });
    expect(host.textContent).toContain('Go online to send a report.');
    expect(button(host, 'Send report')!.disabled).toBe(true);
    expect(button(host, 'Report this reply')!.disabled).toBe(true);
    Object.defineProperty(window.navigator, 'onLine', { configurable: true, value: true });
    await act(() => { window.dispatchEvent(new window.Event('online')); });
    allowed = true;
    await act(() => button(host, 'Send report')!.click()); await flush();
    expect(requests).toHaveLength(1);
    expect(host.textContent).toContain(receipt);
  } finally { await restore(); }
});
