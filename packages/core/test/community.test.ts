import { describe, expect, test } from 'bun:test';
import { analyzeText, communityLinks, communityIdentityKey, validateCommunitySubmission, applyCommunityReplies, communityLookupParams, SubmissionError } from '../src';

const submission = { productName:'Oat drink',brand:'Maker',barcode:'3017620422003',market:'se',variant:'Vanilla 1 L',
  question:'Is the vitamin D plant derived?',reply:'The vitamin D is plant derived.',repliedOn:'2026-01-10',
  claim:'vegan',scope:'ingredients',sourceUrl:'https://maker.example/contact' };
describe('community contributions', () => {
  test('validates scope and identity, canonicalizes equivalent GTINs and ignores unrelated history', () => {
    const value = validateCommunitySubmission({...submission,photos:['private'],history:'private'});
    expect(value.barcode).toBe('03017620422003'); expect(value.market).toBe('SE');
    expect(Object.keys(value)).toHaveLength(11);
    expect(communityIdentityKey(' ＭＡＫＥＲ  Oat\nDrink ')).toBe('maker oat drink');
  });
  test.each([
    ['barcode','3017620422004'],['market','Sweden'],['repliedOn','2026-02-30'],['repliedOn','2099-01-01'],
    ['claim','definitely'],['scope','some'],['productName',' '],['reply','x'.repeat(8001)],
    ['sourceUrl','https://user:secret@maker.example/'],['sourceUrl','https://127.0.0.1/source'],
  ])('rejects invalid %s', (field,value) => {
    try { validateCommunitySubmission({...submission,[field]:value}); throw new Error('accepted invalid input'); }
    catch (error) { expect(error).toBeInstanceOf(SubmissionError); expect((error as SubmissionError).field).toBe(field); }
  });
  test('prefills only product identity in a URL fragment without mutating a saved result', () => {
    const result = {...analyzeText({text:'vitamin D',name:'Oat & drink',brand:'Maker',barcode:'3017620422003'}),photos:['private-photo']};
    const before = JSON.stringify(result);
    const links = communityLinks(result,'sv','https://community.example/path')!;
    const url = new URL(links.submit); expect(url.search).toBe(''); expect(url.pathname).toBe('/submit');
    const params = new URLSearchParams(url.hash.slice(1)); expect(params.get('name')).toBe('Oat & drink'); expect(params.get('lang')).toBe('sv');
    expect([...params.keys()].every(key => ['name','brand','barcode','market','lang'].includes(key))).toBe(true);
    expect(links.submit).not.toContain('vitamin'); expect(links.submit).not.toContain('private'); expect(JSON.stringify(result)).toBe(before);
    expect(communityLinks(result,'fr','https://community.example')?.submit).toContain('lang=en');
    expect(communityLinks(result,'en','')).toBeUndefined(); expect(communityLinks(result,'en','http://community.example')).toBeUndefined();
  });
});

describe('community verdicts and coverage', () => {
  const reply = { ...submission, id:'12345678-1234-4234-8234-123456789abc', reviewedAt:'2026-01-11T00:00:00Z', evidencePublic:false,
    scope:'whole_product' as const, claim:'vegan' as const, match:'barcode' as const };
  test('whole-product replies update a display copy and preserve private scan/history fields', () => {
    const original = analyzeText({text:'vitamin D',name:'Oat drink',brand:'Maker',market:'SE'});
    const before = JSON.stringify(original);
    const result = applyCommunityReplies(original,[reply],'en','https://community.example');
    expect(result.outcome).toBe('vegan'); expect(result.basis).toBe('manufacturer'); expect(result.title).toBe('Manufacturer says vegan');
    expect(result.evidence.at(-1)?.sourceDate).toBe(`${reply.repliedOn}T00:00:00Z`);
    expect(JSON.stringify(original)).toBe(before);
    expect(applyCommunityReplies(original,[],'en')).toBe(original);
  });
  test('ingredient-only, processing-only, inconclusive and unconfirmed range replies never establish a whole-product verdict', () => {
    const original = analyzeText({text:'vitamin D'});
    for (const scoped of [{...reply,scope:'ingredients' as const},{...reply,scope:'processing' as const},
      {...reply,claim:'inconclusive' as const},{...reply,match:'candidate' as const}]) expect(applyCommunityReplies(original,[scoped],'en')).toBe(original);
  });
  test('negative replies and contradictory ingredient or manufacturer evidence are explicit', () => {
    const uncertain = analyzeText({text:'vitamin D'});
    const negative = {...reply,claim:'not_vegan' as const};
    expect(applyCommunityReplies(uncertain,[negative],'en').title).toBe('Manufacturer says not vegan');
    expect(applyCommunityReplies(uncertain,[reply,negative],'en').outcome).toBe('conflicting');
    expect(applyCommunityReplies(analyzeText({text:'milk'}),[reply],'en').outcome).toBe('conflicting');
    expect(applyCommunityReplies({...uncertain,outcome:'vegan'},[negative],'en').outcome).toBe('conflicting');
  });
  test('coverage validates each barcode and country and canonicalizes product targets', () => {
    const coverage = {type:'products',markets:['se','DE'],products:[{productName:'Drink',brand:'Maker',barcode:'3017620422003',variant:''}]};
    const parsed = validateCommunitySubmission({...submission,coverage});
    expect(parsed.coverage?.products[0]?.barcode).toBe('03017620422003');
    expect(parsed.coverage?.markets).toEqual(['SE','DE']);
    expect(()=>validateCommunitySubmission({...submission,coverage:{...coverage,products:[{...coverage.products[0],barcode:'3017620422004'}]}})).toThrow();
    expect(()=>validateCommunitySubmission({...submission,coverage:{...coverage,markets:['US']}})).toThrow();
  });
  test('lookup sends names alongside barcodes for range discovery and no private evidence', () => {
    const params = communityLookupParams({name:'Fun Light Lemon',brand:'Fun Light',barcode:'3017620422003',market:'SE',match:'exact_barcode'});
    expect([...params.keys()]).toEqual(['market','barcode','name','brand']);
    expect(params.get('barcode')).toBe('03017620422003');
  });
});
