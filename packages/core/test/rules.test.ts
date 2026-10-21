import { describe, expect, test } from 'bun:test';
import rules from '../../../data/rules.json';
import { analyzeText, normalizeTerm } from '../src';
import { ruleForTerm } from '../src/analyze';

const aliasRule = new Map(rules.rules.flatMap(rule => rule.aliases.map(alias => [normalizeTerm(alias), rule] as const)));

describe('rule data', () => {
  test('rules have unique kebab-case ids, a status, en/de explanations and known sources', () => {
    const ids = new Set<string>();
    const sourceIds = new Set(rules.sources.map(source => source.id));
    for (const rule of rules.rules) {
      expect(rule.id).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
      expect(ids.has(rule.id)).toBe(false);
      ids.add(rule.id);
      expect(['plant', 'animal', 'ambiguous']).toContain(rule.status);
      expect(rule.explanation.en.trim()).not.toBe('');
      expect(rule.explanation.de.trim()).not.toBe('');
      expect(rule.aliases.length).toBeGreaterThan(0);
      expect(rule.sourceIds.length).toBeGreaterThan(0);
      expect(rule.sourceIds.filter(id => !sourceIds.has(id))).toEqual([]);
    }
  });
  test('normalized aliases never collide across rules', () => {
    const seen = new Map<string, string>();
    const collisions: string[] = [];
    for (const rule of rules.rules) for (const alias of rule.aliases) {
      const key = normalizeTerm(alias);
      expect(key).not.toBe('');
      const owner = seen.get(key);
      if (owner && owner !== rule.id) collisions.push(`${key}: ${owner} / ${rule.id}`);
      seen.set(key, rule.id);
    }
    expect(collisions).toEqual([]);
  });
  test('compound stems are animal aliases and plant exceptions are not', () => {
    for (const stem of rules.extendedMatching.compoundStems) expect(aliasRule.get(normalizeTerm(stem))?.status).toBe('animal');
    for (const exception of rules.extendedMatching.plantExceptions) expect(aliasRule.get(normalizeTerm(exception))?.status ?? 'plant').toBe('plant');
  });
});

describe('extended animal matching', () => {
  test('a contained animal alias or compound stem yields the exact rule while the term is preserved', () => {
    expect(ruleForTerm('milk powder from alpine milk')?.id).toBe('milk');
    expect(ruleForTerm('alpenmilchpulver')?.id).toBe('milk');
    expect(ruleForTerm('rindsleder')?.id).toBe('leather');
    const result = analyzeText({ text: 'Ingredients: sugar, milk powder from alpine milk', category: 'food' });
    expect(result.findings.map(item => [item.term, item.status, item.ruleId])).toEqual([['sugar', 'plant', 'sugar'], ['milk powder from alpine milk', 'animal', 'milk']]);
  });
  test('plant exceptions, negations, substitutes and flavours never match an animal rule', () => {
    for (const term of ['oat milk powder', 'hafermilchkonzentrat', 'kokosmilchpulver', 'cream of tartar', 'erdnussbutter', '-baumwolle', 'honigmelone', 'milchsäurebakterien',
      "lamb's lettuce", 'oyster mushroom powder', 'milk-free chocolate', 'non-dairy creamer', 'vegan cheese alternative', 'laktosefrei', 'käsearoma', 'cheese flavour', 'ei sisällä maitoa']) {
      expect(ruleForTerm(term)).toBeUndefined();
    }
  });
  test('plant and ambiguous rules only match exactly', () => {
    expect(ruleForTerm('natural flavouring with vanilla')).toBeUndefined();
    expect(ruleForTerm('e471 from palm oil')).toBeUndefined();
    expect(ruleForTerm('wheat flour blend')).toBeUndefined();
  });
  test('AI-split terms and local guards share the extended matching without duplicate findings', () => {
    const text = 'Ingredients: sugar, alpine milk powder, kapselhülle: gelatine';
    const result = analyzeText({ text, category: 'food' }, undefined, ['sugar', 'alpine milk powder', 'gelatine']);
    expect(result.outcome).toBe('not_vegan');
    expect(result.findings.map(item => [item.term, item.ruleId])).toEqual([['sugar', 'sugar'], ['alpine milk powder', 'milk'], ['gelatine', 'gelatin']]);
  });
});
