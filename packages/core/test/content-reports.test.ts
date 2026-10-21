import { describe, expect, test } from 'bun:test';
import { analyzeText, resultReport, resultReportBytes, validateContentReport, REPORT_LIMITS, SubmissionError } from '../src';

const client = { locale: 'en', platform: 'extension' as const, appVersion: '0.2.19' };
describe('result reports', () => {
  test('carry only the verdict, ingredient terms with status and rule, product identity and client details', () => {
    const result = { ...analyzeText({ text: 'Ingredients: water, milk, E471', name: ' Oat & drink ', brand: 'Maker', barcode: '3017620422003' }), photos: ['private-photo'] };
    const report = resultReport(result, client);
    expect(report).toEqual({ product: 'Oat & drink', brand: 'Maker', outcome: 'not_vegan', locale: 'en', platform: 'extension', appVersion: '0.2.19',
      findings: result.findings.map(finding => ({ term: finding.term, status: finding.status, ruleId: finding.ruleId ?? '' })) });
    expect(report.findings.some(finding => finding.term === 'milk' && finding.status === 'animal' && finding.ruleId)).toBe(true);
    const serialized = JSON.stringify(validateContentReport({ kind: 'result', contentId: '', text: '', reason: ' E471 is plant based here ', result: report }));
    for (const term of ['private-photo', 'explanation', 'evidence', 'barcode', 'history']) expect(serialized).not.toContain(term);
    expect(JSON.parse(serialized)).toMatchObject({ kind: 'result', reason: 'E471 is plant based here', result: report });
  });
  test('truncates oversized values instead of failing the report', () => {
    const result = analyzeText({ text: 'water', name: 'x'.repeat(400) });
    const long = { ...result, findings: Array.from({ length: 250 }, (_, index) => ({ term: 'y'.repeat(300), status: 'unknown' as const, ruleId: 'z'.repeat(150), explanation: '', evidenceId: `${index}` })) };
    const report = resultReport(long, { ...client, appVersion: 'v'.repeat(50) });
    expect(report.product).toHaveLength(300); expect(report.appVersion).toHaveLength(40);
    expect(report.findings[0]).toEqual({ term: 'y'.repeat(200), status: 'unknown', ruleId: 'z'.repeat(100) });
    // Maximum-length findings are trimmed from the end so the serialized details fit the Worker's body limit.
    expect(report.findings.length).toBeGreaterThan(50); expect(report.findings.length).toBeLessThan(200);
    expect(resultReportBytes(report)).toBeLessThanOrEqual(REPORT_LIMITS.bytes);
    expect(() => validateContentReport({ kind: 'result', contentId: '', text: '', reason: 'Wrong', result: report })).not.toThrow();
    const short = resultReport({ ...long, findings: long.findings.slice(0, 40) }, client);
    expect(short.findings).toHaveLength(40);
    expect(() => validateContentReport({ kind: 'result', contentId: '', text: '', reason: 'Wrong', result: { ...report, findings: Array.from({ length: 100 }, () => report.findings[0]!) } })).toThrow('too large');
  });
  test('drops control characters from database or AI values instead of failing the report', () => {
    const result = { ...analyzeText({ text: 'water' }), identity: { name: ' Oat\u0008 drink\u001f ', brand: '\u007fMaker', market: 'SE', match: 'unconfirmed' as const },
      findings: [{ term: 'mi\u0000lk', status: 'animal' as const, ruleId: 'ru\u001fle', explanation: '', evidenceId: 'e1' }, { term: '\u0001\u0002', status: 'unknown' as const, explanation: '', evidenceId: 'e2' }] };
    const report = resultReport(result, { ...client, appVersion: '0.2\u000019' });
    expect(report).toMatchObject({ product: 'Oat drink', brand: 'Maker', appVersion: '0.219', findings: [{ term: 'milk', status: 'animal', ruleId: 'rule' }] });
    expect(() => validateContentReport({ kind: 'result', contentId: '', text: '', reason: 'Wrong', result: report })).not.toThrow();
  });
  test.each([
    ['unknown report field', { kind: 'ai', contentId: '', text: 'excerpt', reason: 'Issue', credentials: 'private' }],
    ['result on an AI report', { kind: 'ai', contentId: '', text: 'excerpt', reason: 'Issue', result: resultReport(analyzeText({ text: 'water' }), client) }],
    ['missing result details', { kind: 'result', contentId: '', text: '', reason: 'Issue' }],
    ['result with history text', { kind: 'result', contentId: '', text: 'private', reason: 'Issue', result: resultReport(analyzeText({ text: 'water' }), client) }],
    ['invalid outcome', { kind: 'result', contentId: '', text: '', reason: 'Issue', result: { ...resultReport(analyzeText({ text: 'water' }), client), outcome: 'maybe' } }],
    ['invalid platform', { kind: 'result', contentId: '', text: '', reason: 'Issue', result: { ...resultReport(analyzeText({ text: 'water' }), client), platform: 'web' } }],
    ['extra result field', { kind: 'result', contentId: '', text: '', reason: 'Issue', result: { ...resultReport(analyzeText({ text: 'water' }), client), photos: [] } }],
    ['invalid finding status', { kind: 'result', contentId: '', text: '', reason: 'Issue', result: { ...resultReport(analyzeText({ text: 'water' }), client), findings: [{ term: 'milk', status: 'dairy', ruleId: '' }] } }],
    ['finding with explanation', { kind: 'result', contentId: '', text: '', reason: 'Issue', result: { ...resultReport(analyzeText({ text: 'water' }), client), findings: [{ term: 'milk', status: 'animal', ruleId: '', explanation: 'x' }] } }],
    ['too many findings', { kind: 'result', contentId: '', text: '', reason: 'Issue', result: { ...resultReport(analyzeText({ text: 'water' }), client), findings: Array.from({ length: 201 }, () => ({ term: 'milk', status: 'animal', ruleId: '' })) } }],
    ['empty reason', { kind: 'result', contentId: '', text: '', reason: ' ', result: resultReport(analyzeText({ text: 'water' }), client) }],
    ['control characters', { kind: 'ai', contentId: '', text: 'excerpt\u0000', reason: 'Issue' }],
    ['community reply with text', { kind: 'community', contentId: '12345678-1234-4234-8234-123456789abc', text: 'private', reason: 'Issue' }],
  ])('rejects %s', (_name, value) => {
    expect(() => validateContentReport(value)).toThrow(SubmissionError);
  });
  test('accepts the existing AI and community payloads unchanged', () => {
    expect(validateContentReport({ kind: 'ai', contentId: '', text: ' Reviewed excerpt ', reason: ' Offensive ' })).toEqual({ kind: 'ai', contentId: '', text: 'Reviewed excerpt', reason: 'Offensive' });
    expect(validateContentReport({ kind: 'community', contentId: '12345678-1234-4234-8234-123456789abc', text: '', reason: 'Personal data' }).result).toBeUndefined();
  });
});
