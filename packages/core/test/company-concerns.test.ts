import { describe, expect, test } from 'bun:test';
import { analyzeText, attachCompanyConcerns, checkProduct, createCompanyConcernResolver, resolveCompanyConcerns, type CompanyConcernDataset } from '../src';

const dataset: CompanyConcernDataset = {
  version: 1, license: 'AGPL-3.0-only', policy: 'Reviewed conduct only, never mixed product lines alone.',
  entities: [
    { id: 'parent', name: 'Example Parent', kind: 'company', aliases: ['Example Parent, Inc.'] },
    { id: 'brand', name: 'Example Brand', kind: 'brand', aliases: ['Example Brand DE'], parent: { id: 'parent', sourceUrl: 'https://example.invalid/ownership', reviewedAt: '2026-10-06' } },
    { id: 'mixed', name: 'Mixed Products', kind: 'company', aliases: [] },
  ],
  records: [{ id: 'testing', companyId: 'parent', category: 'animal_testing', description: { en: 'Documented testing policy.', de: 'Dokumentierte Tierversuchsrichtlinie.' },
    sourceUrl: 'https://example.invalid/policy', sourceDate: '2017-02', reviewedAt: '2026-10-06', status: 'current', redistribution: 'Original factual summary.' }],
};

describe('reviewed company identity resolver', () => {
  test('matches full names and aliases, including NFKC and whitespace, but no product-title substrings', () => {
    const resolve = createCompanyConcernResolver(dataset);
    expect(resolve('  Ｅxample   Parent ')).toHaveLength(1);
    expect(resolve('Example Parent, Inc.')).toHaveLength(1);
    expect(resolve('Example Parent chocolate')).toEqual([]);
    expect(resolve('Example')).toEqual([]);
    expect(resolve('Mixed Products')).toEqual([]);
    expect(resolve()).toEqual([]);
  });
  test('distinguishes direct conduct from one sourced parent relationship', () => {
    const resolve = createCompanyConcernResolver(dataset);
    const parent = resolve('Example Brand', 'de')[0]!;
    expect(parent.scope).toBe('parent');
    expect(parent.company).toBe('Example Parent');
    expect(parent.matchedBrand).toBe('Example Brand');
    expect(parent.description).toBe('Dokumentierte Tierversuchsrichtlinie.');
    expect(parent.ownershipSourceUrl).toBe('https://example.invalid/ownership');
    expect(parent.ownershipReviewedAt).toBe('2026-10-06T00:00:00.000Z');
    expect(parent.sourceDate).toBe('2017-02');
    const direct = resolve('Example Parent')[0]!;
    expect(direct.scope).toBe('direct');
    expect(direct.ownershipSourceUrl).toBeUndefined();
  });
  test('splits brand metadata only when the complete value is not an alias and deduplicates aliases', () => {
    const resolve = createCompanyConcernResolver(dataset);
    expect(resolve('Example Brand, Example Brand DE, Unknown')).toHaveLength(1);
    expect(resolve('Example Parent, Inc.')[0]?.scope).toBe('direct');
    expect(resolve('Example Brand, Example Parent')).toHaveLength(2);
    expect(resolve(Array.from({ length: 9 }, () => 'Example Brand').join(','))).toEqual([]);
  });
  test('ambiguous aliases are not sufficient to attribute conduct', () => {
    const ambiguous = structuredClone(dataset);
    ambiguous.entities[2]!.aliases = ['Example Parent'];
    expect(createCompanyConcernResolver(ambiguous)('Example Parent')).toEqual([]);
  });
  test('refuses records without sources or dated ownership, and rejects unsupported concern categories', () => {
    const withoutSource = structuredClone(dataset);
    withoutSource.records[0]!.sourceUrl = 'javascript:alert(1)';
    expect(() => createCompanyConcernResolver(withoutSource)).toThrow();
    const withoutOwnership = structuredClone(dataset);
    withoutOwnership.entities[1]!.parent!.reviewedAt = '';
    expect(() => createCompanyConcernResolver(withoutOwnership)).toThrow();
    const unsupported = JSON.parse(JSON.stringify(dataset)) as Record<string, unknown>;
    unsupported.records = [{ ...dataset.records[0], category: 'also_sells_milk' }];
    expect(() => createCompanyConcernResolver(unsupported)).toThrow();
  });
  test('preserves resolved and disputed status instead of presenting every record as current', () => {
    for (const status of ['resolved', 'disputed'] as const) {
      const changed = structuredClone(dataset); changed.records[0]!.status = status;
      expect(createCompanyConcernResolver(changed)('Example Parent')[0]?.status).toBe(status);
    }
  });
});

describe('company indicators remain separate from every product outcome', () => {
  test('bundled records contain source-backed concerns and preserve verdict fields', () => {
    expect(resolveCompanyConcerns('Nestle')[0]?.sourceDate).toBe('2017-02');
    for (const outcome of ['vegan', 'not_vegan', 'uncertain', 'conflicting'] as const) {
      const original = { ...analyzeText({ brand: 'Nestlé', text: 'Ingredients: water, salt', category: 'food' }), outcome };
      const result = attachCompanyConcerns(original);
      expect(result.companyConcerns).toHaveLength(1);
      expect({ ...result, companyConcerns: original.companyConcerns }).toEqual(original);
      expect(original.companyConcerns).toEqual([]);
    }
  });
  test('attaches on offline, background, decisive and missing-provider return paths', async () => {
    for (const options of [{ mode: 'explicit', offline: true }, { mode: 'background' }, { mode: 'explicit' }] as const) {
      for (const text of ['Ingredients: water, salt', 'Ingredients: milk', 'unclear']) {
        const result = await checkProduct({ text, brand: 'Garden Gourmet', category: 'food', complete: true }, options);
        expect(result.companyConcerns[0]?.scope).toBe('parent');
        expect(result.companyConcerns[0]?.matchedBrand).toBe('Garden Gourmet');
      }
    }
  });
  test('matches the final AI-extracted brand and cannot accept AI-invented misconduct', async () => {
    const result = await checkProduct({ name: 'Unidentified package', locale: 'de' }, { mode: 'explicit', provider: {
      extract: async () => ({ text: '', complete: false, category: 'food', brand: 'Hälsans Kök', name: 'Example' }),
    } });
    expect(result.companyConcerns[0]?.matchedBrand).toBe('Hälsans Kök');
    expect(result.companyConcerns[0]?.description).toContain('Nestlés');
    const failure = await checkProduct({ name: 'Example', brand: 'Nestle' }, { mode: 'explicit', provider: {
      extract: async () => { throw new Error('Provider unavailable'); },
    } });
    expect(failure.companyConcerns[0]?.scope).toBe('direct');
    const unknown = await checkProduct({ name: 'Nestlé chocolate', text: 'unknown' }, { mode: 'explicit', offline: true });
    expect(unknown.companyConcerns).toEqual([]);
    const invented = await checkProduct({ name: 'Unknown product' }, { mode: 'explicit', provider: {
      extract: async () => ({ text: '', complete: false, category: 'food', brand: 'Nestle', companyConcerns: [{ company: 'Invented' }] }),
    } });
    expect(invented.companyConcerns).toEqual([]);
    expect(invented.aiStatus).toBe('failed');
  });
  test('uses offline database identity, not an earlier unrelated title', async () => {
    const result = await checkProduct({ barcode: '4006381333931', name: 'Unrelated', category: 'food' }, {
      mode: 'background', offline: true, offlineProducts: { lookup: () => ({
        input: { text: 'milk', brand: 'Nestle', barcode: '4006381333931', category: 'food', complete: false }, labels: [],
        evidence: { id: 'offline', kind: 'database', title: 'Offline example', excerpt: 'milk', retrievedAt: '2026-10-06T00:00:00Z' },
      }) },
    });
    expect(result.outcome).toBe('not_vegan');
    expect(result.companyConcerns[0]?.company).toBe('Nestlé');
  });
});
