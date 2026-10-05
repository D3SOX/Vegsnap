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

test('existing Swedish history gets offline names and questions without changing evidence or outcome', () => {
  const result = analyzeText({ text: 'äppelsyra, naturlig arom, sötningsmedel', category: 'food', complete: true });
  const snapshot = JSON.stringify(result);
  const shown = localizeResult(result, 'en');
  expect(shown.findings.map(finding => finding.displayTerm)).toEqual(['malic acid', 'natural flavouring', 'sweetener']);
  expect(shown.questions.join(' ')).toContain('natural flavouring');
  expect(shown.questions.join(' ')).not.toContain('naturlig arom');
  expect(shown.findings.map(({ term, status }) => ({ term, status }))).toEqual(result.findings.map(({ term, status }) => ({ term, status })));
  expect(shown.outcome).toBe(result.outcome);
  expect(shown.evidence).toEqual(result.evidence);
  expect(JSON.stringify(result)).toBe(snapshot);
  const german = localizeResult(result, 'de');
  expect(german.findings.map(finding => finding.displayTerm)).toEqual(['Äpfelsäure', 'natürliches Aroma', 'Süßungsmittel']);
  expect(german.questions.join(' ')).toContain('Die Herkunft dieser Zutaten klären:');
});

test('saved AI translations apply only in their recorded locale and bundled names take precedence', () => {
  const original = analyzeText({ text: 'unlisted source ingredient, vatten', category: 'food', complete: true });
  original.findings[0] = { ...original.findings[0]!, displayTerm: 'unbekannte Zutat', displayLocale: 'de' };
  original.findings[1] = { ...original.findings[1]!, displayTerm: 'honey', displayLocale: 'en' };
  const english = localizeResult(original, 'en');
  expect(english.findings[0]?.displayTerm).toBeUndefined();
  expect(english.findings[1]?.displayTerm).toBe('water');
  expect(localizeResult(original, 'de').findings[0]?.displayTerm).toBe('unbekannte Zutat');
  expect(english.findings[1]?.status).toBe(original.findings[1]?.status);
});

test('parent ingredient translation never relabels component findings', () => {
  const input = { text: 'mystery blend (cotton)', category: 'clothing' as const, complete: true, locale: 'en' as const };
  const extracted = { text: input.text, category: input.category, complete: true, ingredientAssessments: [{ term: input.text, translatedTerm: 'translated whole blend', status: 'plant' as const, explanation: 'Plant fibres.' }] };
  const result = applyAIEvidence(analyzeText(input), input, extracted, true);
  expect(result.findings.every(finding => finding.displayTerm === undefined)).toBe(true);
});

test('translations cannot overrule a known animal ingredient', () => {
  const input = { text: 'milk', category: 'food' as const, complete: true, locale: 'en' as const };
  const result = applyAIEvidence(analyzeText(input), input, { ...input, ingredientAssessments: [{ term: 'milk', translatedTerm: 'oat drink', status: 'plant', explanation: 'Untrusted model claim.' }] }, true);
  expect(result.outcome).toBe('not_vegan');
  expect(result.findings[0]?.status).toBe('animal');
  expect(localizeResult(result, 'en').findings[0]?.displayTerm).toBeUndefined();
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

test('common condiment ingredients translate offline while preserving source terms and classification', () => {
  const text = 'branntweinessig, gurken, knoblauch, zwiebeln, kräuter, chilis, zitronensaft aus zitronensaftkonzentrat, xanthan';
  const result = analyzeText({ text, category: 'food', complete: true });
  const shown = localizeResult(result, 'en');
  expect(shown.findings.map(f => f.displayTerm ?? f.term)).toEqual(['spirit vinegar', 'cucumbers', 'garlic', 'onions', 'herbs', 'chillies', 'lemon juice from concentrate', 'xanthan gum']);
  expect(shown.findings.map(f => [f.term, f.status])).toEqual(result.findings.map(f => [f.term, f.status]));
  expect(shown.evidence).toEqual(result.evidence);
  expect(shown.outcome).toBe(result.outcome);
});

test('common Swedish food labels have offline English and German display names', () => {
  const text = 'gurka, vitlök, lök, örter, chilipeppar, citronjuice från koncentrat, xantangummi';
  const result = analyzeText({ text, category: 'food', complete: true });
  expect(localizeResult(result, 'en').findings.map(f => f.displayTerm ?? f.term)).toEqual(['cucumbers', 'garlic', 'onions', 'herbs', 'chillies', 'lemon juice from concentrate', 'xanthan gum']);
  expect(localizeResult(result, 'de').findings.map(f => f.displayTerm ?? f.term)).toEqual(['Gurken', 'Knoblauch', 'Zwiebeln', 'Kräuter', 'Chilis', 'Zitronensaft aus Konzentrat', 'Xanthan']);
});
