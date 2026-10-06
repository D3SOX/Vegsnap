import { expect, test } from 'bun:test';
import { analyzeText, validateAIExtraction } from '../src';
import { applyAIEvidence } from '../src/ai-evidence';

test('AI ingredient translation is display-only and keeps source identity', () => {
  const input = { text: 'okänd råvara', category: 'food' as const, complete: true, locale: 'en' as const };
  const extracted = validateAIExtraction({ text: input.text, category: input.category, complete: true, ingredientAssessments: [{ term: 'okänd råvara', translatedTerm: 'unidentified ingredient', status: 'unknown', explanation: 'Origin not established.' }] });
  const original = analyzeText(input);
  const result = applyAIEvidence(original, input, extracted, true);
  expect(result.findings[0]?.term).toBe('okänd råvara');
  expect(result.findings[0]?.displayTerm).toBe('unidentified ingredient');
  expect(result.findings[0]?.displayLocale).toBe('en');
  expect(result.outcome).toBe(original.outcome);
  expect(result.findings[0]?.status).toBe('unknown');
  expect(result.evidence[0]?.excerpt).toBe(input.text);
});

import { localizeResult } from '../src';

test('ingredient display uses saved AI translations only for the matching locale', () => {
  const result = analyzeText({ text: 'äppelsyra, naturlig arom, sötningsmedel', category: 'food', complete: true });
  expect(localizeResult(result, 'en').findings.every(f => f.displayTerm === undefined)).toBe(true);
  result.findings[1] = { ...result.findings[1]!, displayTerm: 'natural flavouring', displayLocale: 'en' };
  const snapshot = JSON.stringify(result);
  const shown = localizeResult(result, 'en');
  expect(shown.findings[1]?.displayTerm).toBe('natural flavouring');
  expect(shown.questions.join(' ')).toContain('natural flavouring');
  expect(localizeResult(result, 'de').findings[1]?.displayTerm).toBeUndefined();
  expect(shown.outcome).toBe(result.outcome);
  expect(shown.evidence).toEqual(result.evidence);
  expect(shown.findings.map(f => f.term)).toEqual(result.findings.map(f => f.term));
  expect(JSON.stringify(result)).toBe(snapshot);
});

test('parent ingredient translation never relabels component findings', () => {
  const input = { text: 'mystery blend (cotton)', category: 'clothing' as const, complete: true, locale: 'en' as const };
  const extracted = { text: input.text, category: input.category, complete: true, ingredientAssessments: [{ term: input.text, translatedTerm: 'translated whole blend', status: 'plant' as const, explanation: 'Plant fibres.' }] };
  const result = applyAIEvidence(analyzeText(input), input, extracted, true);
  expect(result.findings.every(finding => finding.displayTerm === undefined)).toBe(true);
});

test('translations cannot overrule a known animal ingredient', () => {
  const input = { text: 'milk', category: 'food' as const, complete: true, locale: 'de' as const };
  const result = applyAIEvidence(analyzeText(input), input, { ...input, ingredientAssessments: [{ term: 'milk', translatedTerm: 'Milch', status: 'plant', explanation: 'Untrusted model claim.' }] }, true);
  expect(result.outcome).toBe('not_vegan');
  expect(result.findings[0]?.status).toBe('animal');
  expect(localizeResult(result, 'de').findings[0]?.displayTerm).toBe('Milch');
  expect(result.evidence[0]?.excerpt).toBe('milk');
});

test('translation field is optional and strictly bounded', () => {
  const extraction = { text: 'raw ingredient', category: 'food', complete: true };
  const assessment = { term: 'raw ingredient', status: 'unknown', explanation: 'Unknown origin.' };
  expect(validateAIExtraction({ ...extraction, ingredientAssessments: [assessment] }).ingredientAssessments?.[0]?.translatedTerm).toBeUndefined();
  for (const translatedTerm of [7, '', ' ', 'x'.repeat(301)]) expect(() => validateAIExtraction({ ...extraction, ingredientAssessments: [{ ...assessment, translatedTerm }] })).toThrow();
});

import { mergeResults } from '../src/merge-results';
test('duplicate findings keep display metadata without changing evidence precedence', () => {
  const first = analyzeText({ text: 'unfamiliar ingredient', category: 'food', complete: true });
  const translated = structuredClone(first);
  translated.findings[0] = { ...translated.findings[0]!, displayTerm: 'translated ingredient', displayLocale: 'en', evidenceId: 'ai-source' };
  const merged = mergeResults(first, translated);
  expect(merged.findings[0]?.displayTerm).toBe('translated ingredient');
  expect(merged.findings[0]?.evidenceId).toBe(first.findings[0]?.evidenceId);
  expect(merged.outcome).toBe(first.outcome);
});
