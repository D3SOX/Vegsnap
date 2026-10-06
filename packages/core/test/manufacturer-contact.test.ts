import { describe, expect, test } from 'bun:test';
import { analyzeText, applyManufacturerContact, checkProduct, createOpenAIProvider, manufacturerMessage, parseAIExtraction, parseManufacturerContact, safeContactEmail, safeContactUrl, type AIExtraction } from '../src';

const sourceUrl = 'https://maker.example/contact';
const contact = { sourceUrl, url: sourceUrl, email: 'care+food@maker.example', productName: 'Oat drink vanilla', brand: 'Maker' };
const extraction: AIExtraction = { text: 'vitamin D', complete: true, category: 'drink', name: contact.productName, brand: contact.brand, contact,
  research: { searched: true, sources: [{ url: sourceUrl, title: 'Maker customer service' }] } };
const input = { name: contact.productName, brand: contact.brand, images: ['data:image/jpeg;base64,AA=='] };
const check = (value = extraction) => checkProduct(input, { mode: 'explicit', provider: { supportsWebSearch: true, extract: async () => value } });

describe('manufacturer contact', () => {
  test('lists unresolved ingredients once in each language, including without saved questions', () => {
    const result = analyzeText({ text: 'vitamin D, glycerol', complete: true });
    const originQuestions = ['Confirm the origin of:', 'Die Herkunft dieser Zutaten klären:', 'Bekräfta ursprunget för:'];
    for (const locale of ['en', 'de', 'sv'] as const) {
      for (const questions of [[], [...result.questions, ...originQuestions.map(prefix => `${prefix} vitamin d, glycerol.`), 'A custom manufacturer question']]) {
        const body = manufacturerMessage({ ...result, questions }, locale)!.body;
        expect(body.match(/vitamin d/g)).toHaveLength(1);
        expect(body.match(/glycerol/g)).toHaveLength(1);
        expect(body).toContain(`${originQuestions[['en', 'de', 'sv'].indexOf(locale)]} vitamin d, glycerol.`);
        if (questions.length) expect(body).toContain('A custom manufacturer question');
      }
    }
  });
  test('keeps qualifications and additional ingredients in saved origin questions', () => {
    const result = analyzeText({ text: 'glycerol', complete: true });
    const questions = [
      'Confirm the origin of: glycerol in the finished product, not only the raw material.',
      'Die Herkunft dieser Zutaten klären: glycerol im fertigen Produkt.',
      'Bekräfta ursprunget för: glycerol i den färdiga produkten.',
      'Confirm the origin of: glycerol, vitamin D.',
    ];
    for (const locale of ['en', 'de', 'sv'] as const) {
      const body = manufacturerMessage({ ...result, questions }, locale)!.body;
      for (const question of questions) expect(body).toContain(question);
    }
  });
  test('handles long whitespace in origin questions without discarding qualifications', () => {
    const result = { ...analyzeText('glycerol'), questions: [
      `Confirm the origin of:${' '.repeat(60_000)}glycerol in the finished product.`,
    ] };
    expect(manufacturerMessage(result)!.body).toContain('Confirm the origin of: glycerol in the finished product.');
  });
  test('addresses materials and processing questions directly to the manufacturer in every language', () => {
    const questions = [
      'Ask the manufacturer about lining, glue, coatings, and trims.',
      'Den Hersteller nach Futter, Klebstoffen, Beschichtungen und Besatz fragen.',
      'Confirm processing and fining aids with the manufacturer.',
      'Verarbeitungs- und Schönungsmittel beim Hersteller bestätigen lassen.',
    ];
    const result = { ...analyzeText('vitamin D'), questions };
    for (const [locale, materials, processing] of [
      ['en', 'Are the lining, glue', 'Are any animal-derived processing'],
      ['de', 'Sind Futter, Klebstoffe', 'Werden tierische Verarbeitungs-'],
      ['sv', 'Är foder, lim', 'Används några animaliska process-'],
    ] as const) {
      const body = manufacturerMessage(result, locale)!.body;
      expect(body).toContain(materials); expect(body).toContain(processing);
      for (const question of questions) expect(body).not.toContain(question);
    }
  });
  test('Swedish drafts translate standard questions while preserving source identity and custom wording', () => {
    const result = analyzeText({ text: 'vitamin D', name: 'Oat drink', brand: 'Maker', barcode: '4006381333931' });
    result.questions.push('Confirm the origin of: vitamin D.', 'A custom manufacturer question');
    const original = JSON.stringify(result);
    const draft = manufacturerMessage(result, 'sv')!;
    expect(draft.subject).toStartWith('Fråga om produkten är vegansk');
    expect(draft.body).toContain('Hej,');
    expect(draft.body).toContain('Bekräfta ursprunget för: vitamin d.');
    expect(draft.body).not.toContain('Confirm the origin');
    expect(draft.body).not.toContain('Provide the complete');
    expect(draft.body).toContain('A custom manufacturer question');
    expect(draft.body).toContain('4006381333931');
    expect(JSON.stringify(result)).toBe(original);
  });
  test('prepares a draft for unresolved saved results without discovered contact details', () => {
    const result = analyzeText({ text: 'vitamin D', name: 'Oat drink', brand: 'Maker', barcode: '4006381333931' });
    for (const outcome of ['uncertain', 'conflicting'] as const) {
      const draft = manufacturerMessage({ ...result, outcome });
      expect(draft?.body).toContain('Oat drink by Maker');
      expect(draft?.body).toContain('4006381333931');
      expect(draft?.body).toContain('vitamin d');
      expect(draft?.body).not.toContain('Contact source');
      expect(draft?.mailto).toBeUndefined();
    }
    expect(manufacturerMessage(analyzeText('vitamin D'))?.body).toContain('this product');
    expect(manufacturerMessage(analyzeText('vitamin D'), 'de')?.body).toContain('dieses Produkt');
    expect(manufacturerMessage({ ...result, outcome: 'not_vegan' })).toBeUndefined();
  });
  test('attaches consulted matching contact without changing uncertain assessment', async () => {
    const result = await check();
    expect(result.outcome).toBe('uncertain');
    expect(result.manufacturerContact).toEqual(contact);
    const without = await check({ ...extraction, contact: undefined });
    expect(result.findings).toEqual(without.findings);
    expect(result.evidence.map(({ retrievedAt: _at, ...evidence }) => evidence)).toEqual(without.evidence.map(({ retrievedAt: _at, ...evidence }) => evidence));
  });
  test('requires actual search, consulted form and matching input/extracted/final identity', () => {
    const result = analyzeText({ text: 'vitamin D', name: contact.productName, brand: contact.brand });
    for (const bad of [
      { ...extraction, research: undefined },
      { ...extraction, research: { searched: false, sources: extraction.research!.sources } },
      { ...extraction, contact: { ...contact, sourceUrl: 'https://other.example/contact' } },
      { ...extraction, contact: { ...contact, url: 'https://maker.example/guessed-form' } },
      { ...extraction, contact: { ...contact, productName: 'Other flavor' } },
      { ...extraction, brand: 'Other maker' },
    ]) expect(applyManufacturerContact(result, input, bad).manufacturerContact).toBeUndefined();
    expect(applyManufacturerContact(result, { ...input, name: 'Other flavor' }, extraction).manufacturerContact).toBeUndefined();
    expect(applyManufacturerContact({ ...result, identity: { ...result.identity, brand: 'Other maker' } }, input, extraction).manufacturerContact).toBeUndefined();
  });
  test('does not attach a contact to a decisive product or invent one without details', async () => {
    expect((await check({ ...extraction, text: 'milk' })).manufacturerContact).toBeUndefined();
    expect((await check({ ...extraction, contact: undefined })).manufacturerContact).toBeUndefined();
  });
  test('drops malformed optional contact without rejecting the composition', () => {
    const { research: _research, ...modelExtraction } = extraction;
    for (const bad of [null, 'hello', {}, { ...contact, email: 'care@maker.example\r\nBcc:bad@example.org' }, { ...contact, url: 'javascript:alert(1)' }]) {
      const parsed = parseAIExtraction(JSON.stringify({ ...modelExtraction, contact: bad }));
      expect(parsed.text).toBe('vitamin D');
      expect(parsed.contact).toBeUndefined();
    }
    expect(parseAIExtraction(JSON.stringify(modelExtraction)).contact).toEqual(contact);
  });
  test('retains a contact from the bounded research follow-up using actual tool sources', async () => {
    let calls = 0;
    const provider = createOpenAIProvider({ baseUrl: 'https://api.openai.com/v1', model: 'selected', supportsVision: true }, (async () => {
      calls++;
      const data = calls === 1 ? { text: '', complete: false, category: 'drink', name: contact.productName, brand: contact.brand } :
        { text: '', complete: false, category: 'drink', name: contact.productName, brand: contact.brand, contact };
      return new Response(JSON.stringify({ status: 'completed', output: [
        ...(calls === 2 ? [{ type: 'web_search_call', status: 'completed', action: { type: 'open_page', url: sourceUrl } }] : []),
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify(data), annotations: [] }] },
      ] }));
    }) as unknown as typeof fetch);
    const result = await checkProduct(input, { mode: 'explicit', provider });
    expect(calls).toBe(2);
    expect(result.manufacturerContact).toEqual(contact);
  });
  test('contact is gated after a barcode lookup establishes a different identity', async () => {
    const barcode = '4006381333931';
    const result = await checkProduct(input, { mode: 'explicit', provider: { extract: async () => ({ ...extraction, barcode }) },
      fetch: (async () => new Response(JSON.stringify({ product: { code: barcode, product_name: 'Different variant', brands: 'Maker', ingredients_text: 'vitamin D', countries_tags: ['en:germany'] } }))) as unknown as typeof fetch,
    });
    expect(result.identity.name).toBe('Different variant');
    expect(result.manufacturerContact).toBeUndefined();
  });
  test('contact handles conflicts, email-only and form-only responses without background AI', async () => {
    const conflicted = await check({ ...extraction, text: 'milk', webClaims: [{ url: sourceUrl, quote: 'This drink is vegan.', claim: 'vegan', sourceType: 'manufacturer', productName: contact.productName, brand: contact.brand }] });
    expect(conflicted.outcome).toBe('conflicting');
    expect(conflicted.manufacturerContact).toEqual(contact);
    expect(manufacturerMessage(conflicted)?.body).toContain('information conflicts');
    const { email: _email, ...formOnly } = contact;
    expect(manufacturerMessage({ ...conflicted, manufacturerContact: formOnly })?.mailto).toBeUndefined();
    const { url: _url, ...emailOnly } = contact;
    expect((await check({ ...extraction, contact: emailOnly })).manufacturerContact).toEqual(emailOnly);
    let calls = 0;
    const background = await checkProduct(input, { mode: 'background', provider: { extract: async () => { calls++; return extraction; } } });
    expect(calls).toBe(0);
    expect(background.manufacturerContact).toBeUndefined();
  });
  test('unicode truncation cannot break the draft or its mailto encoding', async () => {
    const result = await check();
    result.manufacturerContact = { ...contact, productName: 'x'.repeat(169) + '😀' + 'x'.repeat(100) };
    result.questions = ['x'.repeat(199) + '😀', 'A lone surrogate: \uD800'];
    const draft = manufacturerMessage(result)!;
    expect(draft.subject.length).toBeLessThanOrEqual(200);
    expect(() => decodeURIComponent(draft.mailto!)).not.toThrow();
    expect(draft.body).toContain('A lone surrogate: \uFFFD');
    const formOnly = { ...result, manufacturerContact: { ...contact, email: undefined } };
    expect(manufacturerMessage(formOnly)?.mailto).toBeUndefined();
  });
  test('rejects unsafe and non-public URLs and header-shaped mailboxes', () => {
    for (const url of ['http://maker.example', 'https://user:secret@maker.example', 'https://localhost', 'https://127.0.0.1', 'https://[::1]', 'https://maker.local', 'https://maker.example/\nfoo']) expect(safeContactUrl(url)).toBe(false);
    for (const email of ['care@example.org?bcc=other@example.org', 'care@example.org#x', 'care@example.org&subject=x', 'a..b@example.org', 'x%0d@example.org']) expect(safeContactEmail(email)).toBe(false);
    expect(safeContactEmail(contact.email)).toBe(true);
    expect(parseManufacturerContact({ ...contact, url: undefined, email: undefined })).toBeUndefined();
  });
  test('prepares localized bounded drafts and encoded mailto without personal scan content', async () => {
    const result = await check();
    result.identity.barcode = '4006381333931';
    result.findings[0] = { ...result.findings[0]!, displayTerm: 'vitamin D', displayLocale: 'en' };
    const en = manufacturerMessage(result, 'en')!;
    expect(en.body).toContain(contact.productName);
    expect(en.body).toContain('4006381333931');
    expect(en.body).toContain('vitamin D');
    expect(en.body).toContain(sourceUrl);
    expect(en.body).not.toContain('data:image');
    const mail = new URL(en.mailto!);
    expect(decodeURIComponent(mail.pathname)).toBe(contact.email);
    expect(mail.searchParams.get('subject')).toBe(en.subject);
    expect(mail.searchParams.get('body')).toBe(en.body);
    expect([...mail.searchParams.keys()]).toEqual(['subject', 'body']);
    expect(manufacturerMessage(result, 'de')?.body).toContain('Guten Tag');
    result.questions = Array.from({ length: 100 }, (_, index) => `${index} ${'x'.repeat(1000)}`);
    expect(manufacturerMessage(result)?.body.length).toBeLessThanOrEqual(8000);
    result.questions = []; result.findings = [];
    expect(manufacturerMessage(result)?.body).toContain('including its processing aids');
    expect(manufacturerMessage({ ...result, outcome: 'vegan' })).toBeUndefined();
  });
});
