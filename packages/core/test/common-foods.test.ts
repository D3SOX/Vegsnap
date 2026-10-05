import { describe, expect, test } from 'bun:test';
import { analyzeText, compositionTerms } from '../src/analyze';
import commonFoodExamples from '../../../fixtures/common-foods.json';

const check = (text: string) => analyzeText({ text, category: 'food', complete: true });


describe('common food composition coverage', () => {
  for (const text of commonFoodExamples) test(`recognizes everyday composition: ${text.slice(0, 48)}`, () => {
    const result = check(text);
    expect(result.findings.filter(f => f.status !== 'plant')).toEqual([]);
    expect(result.outcome).toBe('vegan');
  });
  test('additive classes without a named substance are not discarded or marked vegan', () => {
    for (const role of ['Säuerungsmittel', 'Säuerungsmittel:', 'Emulgator()', 'thickener', 'stabiliser:', 'förtjockningsmedel']) {
      const result = check(`water, ${role}`);
      expect(result.outcome).toBe('uncertain');
      expect(result.findings.some(f => f.status === 'unknown')).toBe(true);
    }
    expect(check('Säuerungsmittel (Zitronensäure), Wasser').outcome).toBe('vegan');
  });
  test('heads and compound ingredients never hide milk, eggs, meat, fish, or source-dependent additives', () => {
    for (const text of ['Gemüse - Milch', 'Gurken (Milch)', 'Säuerungsmittel: Milch', 'Verdickungsmittel (Gelatine)', 'Kartoffeln, hönsägg', 'grönsaker, nötkött', 'Tomaten, Fischsauce', 'water, shellfish']) {
      expect(check(text).outcome).toBe('not_vegan');
    }
    for (const text of ['Vegetables - paprika with milk', 'Paprikazubereitung', 'margarine', 'chocolate', 'cheese flavour', 'soy milk', 'sojadryck']) expect(check(text).outcome).toBe('uncertain');
    for (const ingredient of ['E471', 'lecithin', 'natural flavouring', 'vitamin D', 'glycerin']) {
      expect(check(`Gurken, ${ingredient}`).findings.some(f => f.status === 'ambiguous')).toBe(true);
    }
  });
  test('function headings are syntax only when a substance actually follows', () => {
    expect(compositionTerms('Säuerungsmittel: Zitronensäure')).toEqual(['zitronensäure']);
    expect(compositionTerms('Gemüse - Paprika')).toEqual(['paprika']);
    expect(compositionTerms('Verdickungsmittel ()')).toEqual(['verdickungsmittel']);
  });
});
