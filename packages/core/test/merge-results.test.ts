import { expect, test } from 'bun:test';
import curry from '../../../fixtures/massaman-source-merge.json';
import { analyzeText, localizeResult, type CheckResult, type Finding } from '../src';
import { mergeResults } from '../src/merge-results';

const assessedCurry = (): CheckResult => ({ ...analyzeText({ category: 'food' }), outcome: 'vegan', basis: 'composition', usedAI: true,
  findings: curry.findings as Finding[], evidence: [{ id: 'web-composition-0', kind: 'ai_extraction', title: 'Retailer composition (AI)',
    excerpt: curry.composition, retrievedAt: '2026-10-07T10:49:12Z' },
  { id: 'web-composition-0-assessment', kind: 'ai_extraction', title: 'AI ingredient assessment', excerpt: 'Ingredient origins assessed by AI.', retrievedAt: '2026-10-07T10:49:12Z' }] });
const databaseCurry = () => {
  const result = analyzeText({ text: curry.databaseComposition, category: 'food', complete: false });
  result.evidence = [{ ...result.evidence[0]!, id: 'database', kind: 'database' }];
  result.findings = result.findings.map(finding => ({ ...finding, evidenceId: 'database' }));
  return result;
};

for (const databaseFirst of [false, true]) test(`the Pixel curry photo check keeps translated AI ingredients when merging database evidence (${databaseFirst ? 'database first' : 'database last'})`, () => {
  const ai = assessedCurry(), database = databaseCurry();
  expect(database.findings.some(finding => finding.status === 'unknown')).toBe(true);
  const result = databaseFirst ? mergeResults(database, ai) : mergeResults(ai, database);
  expect(result.outcome).toBe('vegan');
  expect(result.findings).toHaveLength(curry.findings.length);
  expect(result.findings.every(finding => finding.status === 'plant')).toBe(true);
  expect(result.findings.map(finding => finding.displayTerm).sort()).toEqual(curry.findings.map(finding => finding.displayTerm).sort());
  expect(result.evidence.some(item => item.id === 'database')).toBe(true);
  expect(result.evidence.some(item => item.id === 'web-composition-0')).toBe(true);
});

test('merging preserves independent unknown ingredients, known origin ambiguity, and animal evidence', () => {
  const ai = assessedCurry();
  ai.findings = [{ term: 'spice blend (rare extract)', status: 'plant', explanation: 'Assessed blend.', evidenceId: 'web-composition-0-assessment' },
    { term: 'glycerin', status: 'plant', explanation: 'A conflicting source claim.', evidenceId: 'web-composition-0-assessment' }];
  const database = analyzeText({ text: 'rare extract, glycerin, milk', category: 'food', complete: false });
  database.evidence = [{ ...database.evidence[0]!, id: 'database', kind: 'database' }];
  database.findings = database.findings.map(finding => ({ ...finding, evidenceId: 'database' }));
  const result = mergeResults(ai, database);
  expect(result.outcome).toBe('conflicting');
  expect(result.findings.find(finding => finding.term === 'rare extract')?.status).toBe('unknown');
  expect(result.findings.filter(finding => finding.term === 'glycerin').map(finding => finding.status).sort()).toEqual(['ambiguous', 'plant']);
  expect(result.findings.find(finding => finding.term === 'milk')?.status).toBe('animal');
});

test('an explicit unresolved AI assessment is retained alongside a different source assessment', () => {
  const ai = assessedCurry();
  const other = analyzeText({ category: 'food' });
  other.evidence = [{ id: 'other-assessment', kind: 'ai_extraction', title: 'Ingredient assessment', excerpt: 'Origin unresolved.', retrievedAt: ai.checkedAt }];
  other.findings = [{ term: 'valkosipuli', status: 'unknown', explanation: 'The source could not be interpreted.', evidenceId: 'other-assessment' }];
  const result = mergeResults(ai, other);
  expect(result.findings.filter(finding => finding.term === 'valkosipuli').map(finding => finding.status).sort()).toEqual(['plant', 'unknown']);
});

test('opening the already-saved Pixel result removes database duplicates without rechecking or changing the stored evidence', () => {
  const ai = assessedCurry(), database = databaseCurry();
  const saved = { ...ai, evidence: [...ai.evidence, ...database.evidence],
    findings: [...ai.findings, ...database.findings.filter(finding => finding.status === 'unknown')] };
  const original = JSON.stringify(saved);
  expect(saved.findings).toHaveLength(23);
  const shown = localizeResult(saved, 'en');
  expect(shown.findings).toHaveLength(13);
  expect(shown.findings.every(finding => finding.status === 'plant' && finding.displayTerm)).toBe(true);
  expect(shown.evidence).toEqual(saved.evidence);
  expect(JSON.stringify(saved)).toBe(original);
});
