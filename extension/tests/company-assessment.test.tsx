/** @jsxImportSource preact */
import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { render } from 'preact';
import { CompanyConcerns } from '../src/company-concerns';
import { resolveCompanyConcerns, type CompanyAssessment } from '@vegsnap/core';
const assessment: CompanyAssessment = { brand: 'Garden Gourmet', company: 'Parent company', scope: 'parent', verdict: 'no_concerns_found', summary: 'The limited sources consulted did not establish a qualifying concern.', categories: [], sources: [{ url: 'https://maker.example/policy', title: 'Policy source', quote: 'The cited policy wording.' }], ownershipSourceUrl: 'https://maker.example/brands', assessedAt: '2026-10-06T12:00:00.000Z' };
function mount(value: CompanyAssessment | undefined, locale: 'en' | 'de' = 'en') {
  const window = new Window(); const document = window.document as unknown as Document;
  const previous = { window: globalThis.window, document: globalThis.document };
  Object.assign(globalThis, { window, document });
  const element = document.createElement('div');
  try { render(<CompanyConcerns concerns={resolveCompanyConcerns('Garden Gourmet', locale)} assessment={value} locale={locale}/>, element); }
  finally { Object.assign(globalThis, previous); }
  return element;
}
test('AI evidence and reviewed records stay distinct with a visible disagreement', () => {
  const element = mount(assessment);
  expect(element.textContent).toContain('AI company assessment');
  expect(element.textContent).toContain('not independently verified');
  expect(element.textContent).toContain('not an ethical endorsement');
  expect(element.textContent).toContain('current concerns that this AI assessment did not report');
  expect(element.textContent).toContain('Reviewed records');
  expect(element.textContent).toContain('Nestlé');
  expect(element.querySelector('blockquote')?.textContent).toBe('The cited policy wording.');
  expect(element.querySelector('time[datetime="2026-10-06T12:00:00.000Z"]')).not.toBeNull();
  expect([...element.querySelectorAll('a')].every(link => link.rel.includes('noreferrer'))).toBe(true);
});
test('absent or malformed AI output is labeled as not assessed, never clearance', () => {
  expect(mount(undefined).textContent).toContain('Company not assessed by AI.');
  expect(mount({ ...assessment, sources: [] }).textContent).toContain('Company not assessed by AI.');
  const invalid = mount({ ...assessment, sources: [{ ...assessment.sources[0]!, url: 'javascript:alert(1)' }] });
  expect(invalid.querySelector('a[href^="javascript:"]')).toBeNull();
  expect(invalid.textContent).not.toContain(assessment.summary);
});
test('German headings and concern categories are translated', () => {
  const element = mount({ ...assessment, verdict: 'concerns_found', categories: ['animal_testing'] }, 'de');
  expect(element.textContent).toContain('KI-Unternehmensbewertung');
  expect(element.textContent).toContain('Bedenken gefunden');
  expect(element.textContent).toContain('Tierversuche');
  expect(element.textContent).toContain('Mutterunternehmen von: Garden Gourmet');
  expect(mount(undefined, 'de').textContent).toContain('Unternehmen nicht von KI bewertet.');
});
