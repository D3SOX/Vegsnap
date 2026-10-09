import { describe, expect, test } from 'bun:test';
import { editableInput, historyExport, type HistoryResult } from '../src/history';

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

  test('keeps original drafts local and excludes them from exports', () => {
    const stored = { ...result(['data:image/jpeg;base64,YQ==']), input: { text: 'Original label', complete: true, category: 'food' as const } };
    expect(historyExport([stored])).toEqual([result()]);
    expect(stored.input.text).toBe('Original label');
  });
});

describe('editing a checked product', () => {
  test('restores the full original text and completeness without using discovered evidence', () => {
    const photos = ['data:image/jpeg;base64,YQ=='];
    const stored: HistoryResult = { ...result(photos), input: { text: 'Original label', complete: true, category: 'food', name: undefined, sourceUrl: 'https://example.com/product' },
      evidence: [{ id: 'database', kind: 'database', title: 'Database label', excerpt: 'Discovered label', retrievedAt: result().checkedAt }] };
    const draft = editableInput(stored);
    expect(draft).toEqual({ text: 'Original label', complete: true, category: 'food', sourceUrl: 'https://example.com/product',
      name: 'Example', brand: undefined, barcode: undefined, market: 'DE', images: photos });
    draft.images?.pop();
    expect(stored.photos).toHaveLength(1);
  });

  test('older results reuse supplied text and identity without assuming completeness', () => {
    const stored: HistoryResult = { ...result(), identity: { name: 'Example', brand: 'Maker', barcode: '4006381333931', market: 'SE', match: 'exact_barcode' }, evidence: [
      { id: 'label', kind: 'user_text', title: 'Label', excerpt: 'Ingredients: oats', retrievedAt: result().checkedAt },
      { id: 'duplicate', kind: 'user_text', title: 'Label', excerpt: 'Ingredients: oats', retrievedAt: result().checkedAt },
      { id: 'web', kind: 'database', title: 'Web label', excerpt: 'Website ingredients', retrievedAt: result().checkedAt },
      { id: 'photo', kind: 'ai_extraction', title: 'AI label', excerpt: 'AI ingredients', retrievedAt: result().checkedAt },
    ] };
    expect(editableInput(stored)).toEqual({ text: 'Ingredients: oats', category: 'other', name: 'Example', brand: 'Maker', barcode: '4006381333931', market: 'SE', images: [] });
    expect(editableInput({ ...stored, evidence: [] }).text).toBe('');
  });
});
