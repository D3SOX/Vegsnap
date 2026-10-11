import { describe, expect, test } from 'bun:test';
import { analyzeText, retainPreviousResearch, type CheckResult } from '../src';

const result = () => analyzeText({ text: 'E920', name: 'Tortillas', brand: 'Maker', market: 'SE', barcode: '4006381333931' });
const previous = (): CheckResult => ({
  ...result(),
  companyAssessment: { brand: 'Maker', company: 'Maker Ltd', scope: 'direct', verdict: 'inconclusive', categories: [],
    summary: 'The published policy does not establish a conclusion.', assessedAt: '2026-10-01T12:00:00Z',
    sources: [{ url: 'https://maker.example/policy', title: 'Policy', quote: 'Our policy.' }] },
  manufacturerContact: { brand: 'Maker', productName: 'Tortillas', email: 'care@maker.example', sourceUrl: 'https://maker.example/contact' },
});

describe('saved research on retry', () => {
  test('preserves omitted research with its original date without changing the new product assessment', () => {
    const fresh = result(), saved = previous();
    const retained = retainPreviousResearch(fresh, saved);
    expect(retained.companyAssessment).toEqual(saved.companyAssessment);
    expect(retained.manufacturerContact).toEqual(saved.manufacturerContact);
    const { companyAssessment: _company, manufacturerContact: _contact, ...product } = retained;
    expect(product).toEqual(fresh);
    expect(fresh.companyAssessment).toBeUndefined();
  });
  test('never transfers research across a changed or incomplete product identity', () => {
    for (const field of ['name', 'brand', 'market', 'barcode'] as const) {
      for (const value of ['Other', '']) {
        const fresh = result(); fresh.identity[field] = value;
        expect(retainPreviousResearch(fresh, previous())).toEqual(fresh);
      }
    }
    const fresh = result(); fresh.identity.name = '  TORTILLAS  ';
    expect(retainPreviousResearch(fresh, previous()).manufacturerContact).toBeDefined();
  });
  test('new sourced research takes precedence and contact is omitted for decisive results', () => {
    const fresh = previous(); fresh.companyAssessment!.assessedAt = '2026-10-11T12:00:00Z';
    fresh.manufacturerContact!.email = 'new@maker.example';
    expect(retainPreviousResearch(fresh, previous())).toEqual(fresh);
    for (const outcome of ['vegan', 'not_vegan'] as const) {
      const retained = retainPreviousResearch({ ...result(), outcome }, previous());
      expect(retained.manufacturerContact).toBeUndefined();
      expect(retained.companyAssessment).toBeDefined();
    }
  });
  test('invalid saved research and mismatching research identities cannot reappear', () => {
    for (const change of [
      (saved: CheckResult) => { saved.companyAssessment!.brand = 'Other'; saved.manufacturerContact!.brand = 'Other'; },
      (saved: CheckResult) => { saved.companyAssessment!.assessedAt = 'invalid'; saved.manufacturerContact!.sourceUrl = 'https://localhost'; },
    ]) {
      const saved = previous(), fresh = result(); change(saved);
      expect(retainPreviousResearch(fresh, saved)).toEqual(fresh);
    }
  });
});
