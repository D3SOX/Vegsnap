import { describe, expect, test } from 'bun:test';
import historySchema from '../../contracts/history.schema.json';
import resultSchema from '../../contracts/result.schema.json';
import { historyExport, type HistoryResult } from '../src/history';
import { HISTORY_IMPORT_MAX_BYTES, mergeHistoryImport, parseHistoryImport } from '../src/history-transfer';

// A small JSON Schema 2020-12 subset covering exactly the keywords the contracts use; anything else fails loudly.
type Schema = Record<string, unknown>;
const documents: Record<string, Schema> = { 'history.schema.json': historySchema, 'result.schema.json': resultSchema };
const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const formats: Record<string, (value: string) => boolean> = {
  'date-time': value => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value)),
  date: value => /^\d{4}-\d{2}-\d{2}$/.test(value), uri: value => URL.canParse(value),
};
function validate(value: unknown, schema: Schema, root: Schema, path = '$'): string[] {
  const errors: string[] = [];
  const fail = (message: string) => errors.push(`${path}: ${message}`);
  for (const [keyword, rule] of Object.entries(schema)) {
    switch (keyword) {
      case '$schema': case '$id': case 'title': case 'description': case '$defs': case 'then': case 'else': break;
      case '$ref': {
        const [file, pointer] = (rule as string).split('#');
        const nextRoot = file ? documents[file]! : root;
        const resolved = (pointer ?? '').split('/').filter(Boolean).reduce<Schema>((node, key) => node[key] as Schema, nextRoot);
        errors.push(...validate(value, resolved, nextRoot, path)); break;
      }
      case 'type': {
        const types = Array.isArray(rule) ? rule as string[] : [rule as string];
        const actual = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
        if (!types.includes(actual) && !(actual === 'number' && Number.isInteger(value) && types.includes('integer'))) fail(`expected ${types.join('|')}, got ${actual}`); break;
      }
      case 'const': if (JSON.stringify(value) !== JSON.stringify(rule)) fail(`expected ${JSON.stringify(rule)}`); break;
      case 'enum': if (!(rule as unknown[]).some(item => JSON.stringify(item) === JSON.stringify(value))) fail(`${JSON.stringify(value)} is not allowed`); break;
      case 'properties': if (isObject(value)) for (const [key, sub] of Object.entries(rule as Record<string, Schema>)) if (key in value) errors.push(...validate(value[key], sub, root, `${path}.${key}`)); break;
      case 'required': if (isObject(value)) for (const key of rule as string[]) if (!(key in value)) fail(`missing ${key}`); break;
      case 'additionalProperties': if (rule === false && isObject(value)) for (const key of Object.keys(value)) if (!(key in ((schema.properties as Schema | undefined) ?? {}))) fail(`unexpected property ${key}`); break;
      case 'items': if (Array.isArray(value)) value.forEach((item, index) => errors.push(...validate(item, rule as Schema, root, `${path}[${index}]`))); break;
      case 'minItems': if (Array.isArray(value) && value.length < (rule as number)) fail('too few items'); break;
      case 'maxItems': if (Array.isArray(value) && value.length > (rule as number)) fail('too many items'); break;
      case 'uniqueItems': if (rule === true && Array.isArray(value) && new Set(value.map(item => JSON.stringify(item))).size !== value.length) fail('duplicate items'); break;
      case 'minLength': if (typeof value === 'string' && [...value].length < (rule as number)) fail('too short'); break;
      case 'maxLength': if (typeof value === 'string' && [...value].length > (rule as number)) fail('too long'); break;
      case 'pattern': if (typeof value === 'string' && !new RegExp(rule as string, 'u').test(value)) fail(`does not match ${rule as string}`); break;
      case 'format': if (typeof value === 'string' && !formats[rule as string]!(value)) fail(`invalid ${rule as string}`); break;
      case 'anyOf': if (!(rule as Schema[]).some(option => validate(value, option, root, path).length === 0)) fail('no anyOf option matched'); break;
      case 'allOf': for (const option of rule as Schema[]) errors.push(...validate(value, option, root, path)); break;
      case 'if': {
        const branch = validate(value, rule as Schema, root, path).length === 0 ? schema.then : schema.else;
        if (branch) errors.push(...validate(value, branch as Schema, root, path)); break;
      }
      case 'dependentRequired': if (isObject(value)) for (const [key, dependencies] of Object.entries(rule as Record<string, string[]>)) if (key in value) for (const dependency of dependencies) if (!(dependency in value)) fail(`${key} requires ${dependency}`); break;
      default: throw new Error(`Unsupported schema keyword: ${keyword}`);
    }
  }
  return errors;
}
const historyErrors = (document: unknown) => validate(document, historySchema, historySchema);

const notice = 'Imported company assessment: sources and quotations have not been verified on this device.';
const checkedAt = '2026-10-05T10:00:00.000Z';
function stored(): HistoryResult {
  const original = { outcome: 'uncertain', basis: 'insufficient', title: 'More information needed', summary: 'Origin of one ingredient is unclear.', questions: ['Is the malic acid synthetic?'], warnings: ['Database record may be outdated.'],
    evidence: [{ id: 'label', kind: 'database', title: 'Open Food Facts', excerpt: 'water, oats, malic acid', url: 'https://world.openfoodfacts.org/product/4006381333931', retrievedAt: checkedAt, sourceDate: '2026-09-01T00:00:00Z', license: 'ODbL-1.0', claim: 'vegan', verification: 'unverified' }] } satisfies HistoryResult['communityOriginal'];
  return {
    ...original, schemaVersion: 1, id: 'local-check', category: 'food',
    identity: { name: 'Oat drink', brand: 'Maker', barcode: '4006381333931', market: 'DE', marketSource: 'database', match: 'exact_barcode' },
    findings: [{ term: 'äppelsyra', displayTerm: 'malic acid', displayLocale: 'en', status: 'ambiguous', ruleId: 'malic-acid', explanation: 'Can be synthetic or animal-derived.', evidenceId: 'label' }],
    crossContact: ['May contain milk.'],
    companyConcerns: [{ id: 'maker-1', company: 'Maker', category: 'animal_testing', description: 'Documented testing.', sourceUrl: 'https://example.com/report', reviewedAt: '2026-01-01T00:00:00Z', status: 'current', scope: 'direct', matchedBrand: 'Maker', sourceDate: '2025-12' }],
    checkedAt, usedAI: true, aiStatus: 'failed', webSearchStatus: 'searched', aiError: { code: 'quota', message: 'Usage allowance exhausted.' },
    manufacturerContact: { email: 'hello@example.com', sourceUrl: 'https://example.com/contact', productName: 'Oat drink', brand: 'Maker' },
    companyAssessment: { brand: 'Maker', company: 'Maker GmbH', scope: 'direct', verdict: 'no_concerns_found', summary: 'No documented concerns.', categories: [], sources: [{ url: 'https://example.com/about', title: 'About', quote: 'We do not test on animals.' }], assessedAt: checkedAt },
    photos: ['data:image/jpeg;base64,YQ=='], input: { text: 'water, oats, malic acid', complete: true, category: 'food' },
    communityOriginal: structuredClone(original),
  };
}
const exported = () => ({ schemaVersion: 1, exportedAt: checkedAt, results: historyExport([stored()]) });

describe('history transfer', () => {
  test('the export document validates against the shared history contract', () => {
    expect(historyErrors(exported())).toEqual([]);
    expect(historyErrors({ schemaVersion: 1, exportedAt: checkedAt, results: [] })).toEqual([]);
    const broken = JSON.parse(JSON.stringify(exported())) as { schemaVersion: number; results: Record<string, unknown>[] };
    broken.results[0]!.photos = ['private'];
    broken.results[0]!.outcome = 'maybe';
    delete broken.results[0]!.identity;
    broken.schemaVersion = 2;
    expect(historyErrors(broken)).toEqual(['$.schemaVersion: expected 1', '$.results[0]: unexpected property photos', '$.results[0].outcome: "maybe" is not allowed', '$.results[0]: missing identity']);
    expect(historyErrors({ schemaVersion: 1, exportedAt: checkedAt, results: Array.from({ length: 1001 }, () => exported().results[0]) })).toEqual(['$.results: too many items']);
  });

  test('an exported file imports its public analysis without provider error copy, contacts, drafts or photos', () => {
    const imported = parseHistoryImport(JSON.stringify(exported()), notice);
    const { aiError: _error, manufacturerContact: _contact, photos: _photos, input: _input, communityOriginal: _community, ...expected } = stored();
    expect(imported).toEqual([{ ...expected, warnings: [...expected.warnings, notice] }]);
    expect(historyErrors({ schemaVersion: 1, exportedAt: checkedAt, results: imported })).toEqual([]);
  });

  test('strips unknown fields, drops assessments for another brand, and keeps the first of duplicate identifiers', () => {
    const [first] = exported().results;
    const foreign = { ...first, photos: ['data:image/jpeg;base64,YQ=='], input: { text: 'private draft' }, communityOriginal: {}, surprise: true, companyAssessment: { ...first!.companyAssessment, brand: 'Other' }, warnings: [notice] };
    const imported = parseHistoryImport(JSON.stringify({ schemaVersion: 1, results: [foreign, { ...first, title: 'Duplicate' }] }), notice);
    expect(imported).toHaveLength(1);
    expect(imported[0]).not.toHaveProperty('photos');
    expect(imported[0]).not.toHaveProperty('input');
    expect(imported[0]).not.toHaveProperty('surprise');
    expect(imported[0]).not.toHaveProperty('companyAssessment');
    expect(imported[0]?.warnings).toEqual([]);
    expect(imported[0]?.title).toBe(first!.title);
  });

  test('a notice from another language is replaced by one local notice only while an assessment is kept', () => {
    const german = 'Importierte Unternehmensbewertung: Quellen und Zitate wurden auf diesem Gerät nicht überprüft.';
    const [first] = exported().results;
    const file = (warnings: string[], assessment = true) => JSON.stringify({ schemaVersion: 1, results: [{ ...first, warnings, ...(assessment ? {} : { companyAssessment: undefined }) }] });
    expect(parseHistoryImport(file(['Keep me', german, notice]), notice, [german])[0]?.warnings).toEqual(['Keep me', notice]);
    expect(parseHistoryImport(file(['Keep me', german], false), notice, [german])[0]?.warnings).toEqual(['Keep me']);
  });

  test('rejects unsupported files and invalid results before anything is saved', () => {
    const document = (results: unknown[], version = 1) => JSON.stringify({ schemaVersion: version, results });
    const [first] = exported().results;
    expect(() => parseHistoryImport('{bad json', notice)).toThrow('Unsupported history file.');
    expect(() => parseHistoryImport('[]', notice)).toThrow('Unsupported history file.');
    expect(() => parseHistoryImport(document([first], 2), notice)).toThrow('Unsupported history file.');
    expect(() => parseHistoryImport(document(Array.from({ length: 1001 }, () => first)), notice)).toThrow('Unsupported history file.');
    expect(() => parseHistoryImport(document(['result']), notice)).toThrow('Invalid history result.');
    expect(() => parseHistoryImport(document([{ ...first, outcome: 'maybe' }]), notice)).toThrow('Invalid history result.');
    expect(() => parseHistoryImport(document([{ ...first, id: '' }]), notice)).toThrow('Invalid history result.');
    expect(() => parseHistoryImport(document([{ ...first, checkedAt: 'yesterday' }]), notice)).toThrow('Invalid history result.');
    expect(() => parseHistoryImport(document([{ ...first, checkedAt: 'Oct 5, 2026' }]), notice)).toThrow('Invalid history result.');
    expect(() => parseHistoryImport(document([{ ...first, checkedAt: '2026/10/05' }]), notice)).toThrow('Invalid history result.');
    expect(() => parseHistoryImport(document([{ ...first, evidence: [{ ...first!.evidence[0], retrievedAt: '2026-10-05' }] }]), notice)).toThrow('Invalid history result.');
    expect(() => parseHistoryImport(document([{ ...first, usedAI: 'yes' }]), notice)).toThrow('Invalid history result.');
    expect(() => parseHistoryImport(document([{ ...first, identity: { ...first!.identity, barcode: '123' } }]), notice)).toThrow('Invalid history result.');
    expect(() => parseHistoryImport(document([{ ...first, findings: [{ term: 'x', status: 'plant', explanation: 'y', evidenceId: 'z', displayTerm: 'only' }] }]), notice)).toThrow('Invalid history result.');
    expect(() => parseHistoryImport(document([{ ...first, evidence: [{ ...first!.evidence[0], url: 'javascript:alert(1)' }] }]), notice)).toThrow('Invalid history result.');
    expect(() => parseHistoryImport(document([{ ...first, warnings: Array.from({ length: 101 }, () => 'w') }]), notice)).toThrow('Invalid history result.');
    expect(() => parseHistoryImport(`{"schemaVersion":1,"results":[],"padding":"${'x'.repeat(HISTORY_IMPORT_MAX_BYTES)}"}`, notice)).toThrow('History files must be smaller than 5 MB.');
  });

  test('merging keeps saved checks and counts transferred duplicates', () => {
    const [first] = parseHistoryImport(JSON.stringify(exported()), notice);
    const incoming = [{ ...first!, title: 'Replacement' }, { ...first!, id: 'new-check' }];
    const merged = mergeHistoryImport([stored()], incoming);
    expect(merged.added.map(item => item.id)).toEqual(['new-check']);
    expect(merged.skipped).toBe(1);
    expect(mergeHistoryImport([], incoming).added).toHaveLength(2);
  });
});
