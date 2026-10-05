import { expect, test } from 'bun:test';
import { analyzeText, checkProduct } from '../src';

const title = 'adidas originals aspyre - trainers - cloud white/grey one/white - zalando';
const materials = 'Obermaterial: Leder/Synthetik\nInnenmaterial: Textil\nInnensohle: Kunststoff';
test('footwear component roles and mixed materials identify leather without treating the product title as a material', () => {
  const result = analyzeText({ text: `${title}\n${materials}`, category: 'shoes' });
  expect(result.outcome).toBe('not_vegan');
  expect(result.findings.map(item => [item.term, item.status])).toEqual([
    ['leder', 'animal'], ['synthetik', 'plant'], ['textil', 'ambiguous'], ['kunststoff', 'plant'],
  ]);
});
test('an explicitly supplied product identity is not itself composition', () => {
  const result = analyzeText({ text: title, name: title, category: 'shoes' });
  expect(result.findings).toEqual([]);
  expect(result.outcome).toBe('uncertain');
});
test('material blends preserve genuine unknowns, fabric ambiguity and synthetic leather distinctions', () => {
  const result = analyzeText({ text: 'Upper: synthetic leather/plastic\nLining: textile\nInsole: mysterious fibre', category: 'shoes', complete: true });
  expect(result.findings.map(item => [item.term, item.status])).toEqual([
    ['synthetic leather', 'plant'], ['plastic', 'plant'], ['textile', 'ambiguous'], ['mysterious fibre', 'unknown'],
  ]);
  expect(result.outcome).toBe('uncertain');
  expect(analyzeText({ text: 'Milk', name: 'Milk', category: 'food' }).outcome).toBe('not_vegan');
  expect(analyzeText({ text: 'unbekannter Werkstoff', category: 'shoes' }).findings[0]?.status).toBe('unknown');
  expect(analyzeText({ text: 'echtes Leder', category: 'shoes' }).outcome).toBe('not_vegan');
});
test('AI assessments use the same normalized material roles and blend boundaries', async () => {
  const text = 'Obermaterial: novel polymer/another polymer\nInnenmaterial: Textil';
  const result = await checkProduct({ text, category: 'shoes', complete: true }, { mode: 'explicit', provider: { extract: async () => ({
    text, category: 'shoes', complete: true, ingredientAssessments: [
      { term: 'Obermaterial: novel polymer/another polymer', status: 'plant', explanation: 'Both named materials are synthetic polymers.' },
      { term: 'Innenmaterial: Textil', status: 'plant', explanation: 'Unsupported claim that every textile is plant-based.' },
    ],
  }) } });
  expect(result.findings.map(item => item.status)).toEqual(['plant', 'plant', 'ambiguous']);
  expect(result.findings[0]?.explanation).toStartWith('AI assessment:');
  expect(result.outcome).toBe('uncertain');
});
test('animal role assessments map a single material but do not label every part of a blend', async () => {
  const text = 'Upper: unfamiliar hide\nLining: novel fibre/another fibre';
  const result = await checkProduct({ text, category: 'shoes', complete: true }, { mode: 'explicit', provider: { extract: async () => ({
    text, category: 'shoes', complete: true, ingredientAssessments: [
      { term: 'Upper: unfamiliar hide', status: 'animal', explanation: 'This named material is animal hide.' },
      { term: 'Lining: novel fibre/another fibre', status: 'animal', explanation: 'The blend includes animal content, without identifying which fibre.' },
    ],
  }) } });
  expect(result.findings.map(item => item.status)).toEqual(['animal', 'unknown', 'unknown']);
  expect(result.outcome).toBe('not_vegan');
});
