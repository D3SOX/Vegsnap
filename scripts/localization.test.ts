import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { androidText, generateStrings, renderCatalog, validateCatalog } from './localization';

const catalog = validateCatalog(await Bun.file(new URL('../localization/strings.json', import.meta.url)).json());

describe('shared application strings', () => {
  test('checked-in platform resources match the catalog', async () => {
    await generateStrings(true);
  });

  test('one shared message reaches every consumer with its existing key', () => {
    const output = renderCatalog(validateCatalog({ cancel: {
      en: 'Cancel', de: 'Abbrechen', android: ['cancel'], ios: ['Cancel'], share: ['Cancel'], extension: ['app.cancel'],
    } }));
    expect(output.get('android/app/src/main/res/values-de/strings.xml')).toContain('<string name="cancel">Abbrechen</string>');
    for (const directory of ['ios/Vegsnap/Resources', 'ios/ShareExtension']) {
      expect(output.get(`${directory}/de.lproj/Localizable.strings`)).toContain('"Cancel" = "Abbrechen";');
    }
    expect(output.get('extension/src/i18n.ts')).toContain('"cancel": "Abbrechen"');
  });

  test('Android escaping preserves punctuation, whitespace and formatting arguments', () => {
    expect(androidText('Tom & Jerry <3')).toBe('Tom &amp; Jerry &lt;3');
    expect(androidText('It\'s "fine"\\\n%1$s')).toBe('It\\\'s \\"fine\\"\\\\\\n%1$s');
    expect(androidText(' prefix: ')).toBe('" prefix: "');
    expect(androidText('two  spaces')).toBe('"two  spaces"');
    expect(androidText('@label')).toBe('"@label"');
  });

  test('native plural forms and positional formats survive generation', () => {
    const output = renderCatalog(validateCatalog({ checks: {
      en: { one: '%1$d check', other: '%1$d checks' }, de: { one: '%1$d Prüfung', other: '%1$d Prüfungen' }, android: ['checks'],
    } }));
    expect(output.get('android/app/src/main/res/values-de/strings.xml')).toContain('<item quantity="other">%1$d Prüfungen</item>');
  });

  test('result engines and saved-result translations share the same text', () => {
    const output = renderCatalog(validateCatalog({ origin: {
      en: 'Origin unknown.', de: 'Herkunft unbekannt.', core: ['result.unknownOrigin'], androidResult: ['unknownOrigin'], savedResult: true,
    } }));
    expect(output.get('packages/core/src/i18n.ts')).toContain('"unknownOrigin": "Herkunft unbekannt."');
    expect(output.get('android/app/src/main/java/app/vegsnap/ResultStrings.kt')).toContain('fun unknownOrigin(german: Boolean): String = if (german) "Herkunft unbekannt." else "Origin unknown."');
    expect(JSON.parse(output.get('data/result-translations.json')!)).toEqual({ terms: [{ en: 'Origin unknown.', de: 'Herkunft unbekannt.' }] });
  });

  test('rejects missing translations, conflicting keys and damaged placeholders', () => {
    expect(() => validateCatalog({ cancel: { en: 'Cancel', android: ['cancel'] } })).toThrow('Missing translation');
    expect(() => validateCatalog({ account: { en: 'Remove {account}', de: 'Konto entfernen', extension: ['app.remove'] } })).toThrow('Formatting arguments');
    expect(() => validateCatalog({ count: { en: '%1$d checks', de: '%1$s Prüfungen', android: ['count'] } })).toThrow('Formatting arguments');
    expect(() => validateCatalog({ a: { en: 'A', de: 'A', android: ['same'] }, b: { en: 'B', de: 'B', android: ['same'] } })).toThrow('Duplicate binding');
    expect(() => validateCatalog({ checks: { en: { one: 'Check', other: 'Checks' }, de: { other: 'Prüfungen' }, android: ['checks'] } })).toThrow('invalid plurals');
  });

  test('iOS literal localization lookups all have catalog entries', async () => {
    const keys = new Set(Object.values(catalog).flatMap(message => message.ios ?? []));
    for await (const path of new Bun.Glob('ios/Vegsnap/**/*.swift').scan({ cwd: new URL('../', import.meta.url).pathname })) {
      const content = await readFile(new URL(`../${path}`, import.meta.url), 'utf8');
      for (const match of content.matchAll(/\bL\("((?:\\.|[^"\\])*)"\)/g)) {
        const key = JSON.parse(`"${match[1]}"`) as string;
        expect(keys.has(key), `${path}: missing iOS string ${key}`).toBe(true);
      }
    }
  });
});
