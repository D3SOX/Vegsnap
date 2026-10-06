import { describe, expect, test } from 'bun:test';
import { analyzeText, communityLinks, communityIdentityKey, validateCommunitySubmission, SubmissionError } from '../src';

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
