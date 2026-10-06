/** @jsxImportSource preact */
import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { analyzeText } from '@vegsnap/core';
import { ManufacturerContactSection } from '../src/manufacturer-contact';

const result = { ...analyzeText({ text: 'vitamin D' }), manufacturerContact: { email: 'care@maker.example', sourceUrl: 'https://maker.example/contact', url: 'https://maker.example/contact', productName: 'Oat drink', brand: 'Maker' } };
async function mounted(testBody: (element: HTMLElement) => Promise<void>, rejectCopy = false) {
  const window = new Window(); const document = window.document as unknown as Document;
  const previous = { window: globalThis.window, document: globalThis.document, navigator: globalThis.navigator };
  const clipboard = { writeText: async (_text: string) => { if (rejectCopy) throw new Error('Denied'); } };
  Object.assign(globalThis, { window, document, navigator: { clipboard } });
  const element = document.createElement('div');
  try { await act(() => render(<ManufacturerContactSection result={result} locale="en"/>, element)); await testBody(element); }
  finally { render(null, element); Object.assign(globalThis, previous); }
}
test('manufacturer actions expose reviewed sources, a draft and a populated email link', async () => {
  await mounted(async element => {
    expect(element.textContent).toContain('AI read these contact details');
    expect(element.textContent).toContain('You review and send');
    expect(element.querySelector('textarea')?.readOnly).toBe(true);
    const mail = element.querySelector<HTMLAnchorElement>('a[href^="mailto:"]')!;
    expect(mail.textContent).toBe('Open in email app');
    expect(new URL(mail.href).searchParams.get('body')).toContain('Oat drink');
    await act(async () => { element.querySelector('button')!.click(); await Promise.resolve(); });
    expect(element.querySelector('[role="status"]')?.textContent).toBe('Message copied.');
  });
});
test('clipboard failure is visible and opens the selectable draft', async () => {
  await mounted(async element => {
    await act(async () => { element.querySelector('button')!.click(); await Promise.resolve(); });
    expect(element.querySelector('[role="alert"]')?.textContent).toContain('Could not copy');
    expect(element.querySelector('details')?.open).toBe(true);
  }, true);
});
