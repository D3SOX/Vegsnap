import { describe, expect, test } from 'bun:test';
import { historyExport, type HistoryResult } from '../src/history';

function result(photos?: string[]): HistoryResult {
  return {
    schemaVersion: 1, id: 'local-check', outcome: 'uncertain', basis: 'insufficient',
    title: 'Example', summary: 'More information needed', category: 'other',
    identity: { name: 'Example', market: 'DE', match: 'unconfirmed' },
    findings: [], evidence: [], questions: [], warnings: [], crossContact: [], companyConcerns: [],
    checkedAt: '2026-10-05T10:00:00.000Z', usedAI: false,
    ...(photos ? { photos } : {}),
  };
}

describe('local history export', () => {
  test('exports analysis without photos and leaves the stored record intact', () => {
    const photos = ['data:image/jpeg;base64,YQ==', 'data:image/jpeg;base64,Yg=='];
    const stored = result(photos);
    Object.freeze(photos);
    Object.freeze(stored);
    const before = JSON.stringify(stored);
    const exported = historyExport([stored]);
    expect(exported).toEqual([result()]);
    expect(exported[0]).not.toHaveProperty('photos');
    expect(JSON.stringify(exported)).not.toContain('data:image/');
    expect(JSON.stringify(stored)).toBe(before);
    expect(stored.photos).toBe(photos);
    expect(exported[0]).not.toBe(stored);
  });

  test('preserves display translations and safe error metadata without altering source terms', () => {
    const saved: HistoryResult = { ...result(), aiStatus: 'failed', aiError: { code: 'quota', message: 'Usage allowance exhausted.' },
      findings: [{ term: 'äppelsyra', displayTerm: 'malic acid', displayLocale: 'en', status: 'plant', explanation: 'Known ingredient', evidenceId: 'label' }] };
    const exported = historyExport([saved])[0]!;
    expect(exported.aiError).toEqual(saved.aiError);
    expect(exported.findings[0]?.term).toBe('äppelsyra');
    expect(exported.findings[0]?.displayTerm).toBe('malic acid');
  });

  test('text-only history and empty history export normally', () => {
    expect(historyExport([result()])).toEqual([result()]);
    expect(historyExport([])).toEqual([]);
  });
});
