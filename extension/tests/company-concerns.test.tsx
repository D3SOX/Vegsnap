/** @jsxImportSource preact */
import { describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { render } from 'preact';
import { CompanyConcerns } from '../src/company-concerns';
import { resolveCompanyConcerns } from '@veguide/core';

function mount(locale: 'en' | 'de', brand?: string) {
  const window = new Window();
  const document = window.document as unknown as Document;
  const previous = { window: globalThis.window, document: globalThis.document };
  Object.assign(globalThis, { window, document });
  const element = document.createElement('div');
  try { render(<CompanyConcerns locale={locale} concerns={resolveCompanyConcerns(brand, locale)}/>, element); }
  finally { Object.assign(globalThis, previous); }
  return element;
}
describe('company evidence presentation', () => {
  test('shows parent attribution, conduct and ownership sources, status and actual date precision', () => {
    const element = mount('en', 'Hälsans Kök');
    expect(element.textContent).toContain('Parent company of: Hälsans Kök');
    expect(element.textContent).toContain('Animal testing');
    expect(element.textContent).toContain('Current');
    expect(element.textContent).toContain('2017-02');
    expect(element.querySelectorAll('a')).toHaveLength(2);
    expect([...element.querySelectorAll('a')].every(link => link.rel.includes('noreferrer'))).toBe(true);
    expect(element.querySelector('time[datetime="2017-02"]')).not.toBeNull();
  });
  test('shows a localized limited-dataset explanation without a company match', () => {
    const element = mount('de', 'Unknown');
    expect(element.textContent).toContain('begrenzten, geprüften Datenbestand');
    expect(element.textContent).toContain('kein ethisches Gütesiegel');
    expect(element.querySelectorAll('article')).toHaveLength(0);
  });
  test('does not imply parent ownership for a direct company match', () => {
    const element = mount('en', 'Nestle');
    expect(element.textContent).toContain('Matched company or brand: Nestlé');
    expect(element.textContent).not.toContain('Parent company of');
    expect(element.querySelectorAll('a')).toHaveLength(1);
  });
});
