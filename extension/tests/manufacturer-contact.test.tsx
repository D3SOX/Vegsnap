/** @jsxImportSource preact */
import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { analyzeText, type CheckResult } from '@vegsnap/core';
import { ManufacturerContactSection } from '../src/manufacturer-contact';

const result = { ...analyzeText({ text: 'vitamin D' }), manufacturerContact: { email: 'care@maker.example', sourceUrl: 'https://maker.example/contact', url: 'https://maker.example/contact', productName: 'Oat drink', brand: 'Maker' } };
async function mounted(testBody: (element: HTMLElement, copies: string[]) => Promise<void>, rejectCopy = false, value: CheckResult = result) {
  const window = new Window(); const document = window.document as unknown as Document;
  const previous = { window: globalThis.window, document: globalThis.document, navigator: globalThis.navigator };
  const copies: string[] = [];
  const clipboard = { writeText: async (text: string) => { if (rejectCopy) throw new Error('Denied'); copies.push(text); } };
  Object.assign(globalThis, { window, document, navigator: { clipboard } });
  const element = document.createElement('div');
  try { await act(() => render(<ManufacturerContactSection result={value} locale="en"/>, element)); await testBody(element, copies); }
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
test('inline language selection updates the preview, clipboard and email without changing UI language', async () => {
  await mounted(async (element, copies) => {
    const select = element.querySelector('select')!;
    expect(select.parentElement?.textContent).toContain('Message language');
    expect(select.value).toBe('en');
    for (const [language, greeting] of [['sv', 'Hej,'], ['de', 'Guten Tag,'], ['en', 'Hello,']]) {
      await act(() => { select.value = language!; select.dispatchEvent(new window.Event('change', { bubbles: true })); });
      const preview = element.querySelector('textarea')!;
      expect(preview.lang).toBe(language!);
      expect(preview.value).toContain(greeting!);
      expect(element.querySelector('details')?.open).toBe(true);
      expect(element.textContent).toContain('Ask the manufacturer');
      const mail = new URL(element.querySelector<HTMLAnchorElement>('a[href^="mailto:"]')!.href);
      expect(mail.searchParams.get('body')).toContain(greeting!);
      await act(async () => { element.querySelector('button')!.click(); await Promise.resolve(); });
      expect(copies.at(-1)).toBe(preview.value);
    }
  });
});
test('uncertain saved results with manufacturer sources still offer a draft without contact details', async () => {
  const saved = analyzeText({ text: 'vitamin D', name: 'Oat drink', brand: 'Maker' });
  saved.evidence.push({ id: 'manufacturer-composition', kind: 'ai_extraction', title: 'Manufacturer composition (AI)',
    excerpt: 'vitamin D', url: 'https://maker.example/product', retrievedAt: saved.checkedAt });
  await mounted(async element => {
    expect(element.textContent).toContain('Ask the manufacturer');
    expect(element.textContent).toContain('Contact details were not found');
    expect(element.querySelector('textarea')?.value).toContain('Oat drink');
    expect(element.querySelector('a[href^="mailto:"]')).toBeNull();
    expect(element.querySelector('a')).toBeNull();
    await act(async () => { element.querySelector('button')!.click(); await Promise.resolve(); });
    expect(element.querySelector('[role="status"]')?.textContent).toBe('Message copied.');
  }, false, saved);
});
test('decisive results do not offer manufacturer actions', async () => {
  await mounted(async element => { expect(element.textContent).toBe(''); }, false, { ...result, outcome: 'vegan' });
});
test('clipboard failure is visible and opens the selectable draft', async () => {
  await mounted(async element => {
    await act(async () => { element.querySelector('button')!.click(); await Promise.resolve(); });
    expect(element.querySelector('[role="alert"]')?.textContent).toContain('Could not copy');
    expect(element.querySelector('details')?.open).toBe(true);
  }, true);
});
