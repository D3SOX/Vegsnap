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
      en: 'Cancel', de: 'Abbrechen', sv: 'Avbryt', android: ['cancel'], ios: ['Cancel'], share: ['Cancel'], extension: ['app.cancel'],
    } }));
    expect(output.get('android/app/src/main/res/values-de/strings.xml')).toContain('<string name="cancel">Abbrechen</string>');
    expect(output.get('android/app/src/main/res/values-sv/strings.xml')).toContain('<string name="cancel">Avbryt</string>');
    for (const directory of ['ios/Vegsnap/Resources', 'ios/ShareExtension']) {
      expect(output.get(`${directory}/de.lproj/Localizable.strings`)).toContain('"Cancel" = "Abbrechen";');
      expect(output.get(`${directory}/sv.lproj/Localizable.strings`)).toContain('"Cancel" = "Avbryt";');
    }
    expect(output.get('extension/src/i18n.ts')).toContain('"cancel": "Abbrechen"');
    expect(output.get('extension/src/i18n.ts')).toContain('"cancel": "Avbryt"');
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
      en: { one: '%1$d check', other: '%1$d checks' }, de: { one: '%1$d Prüfung', other: '%1$d Prüfungen' },
      sv: { one: '%1$d kontroll', other: '%1$d kontroller' }, android: ['checks'],
    } }));
    expect(output.get('android/app/src/main/res/values-de/strings.xml')).toContain('<item quantity="other">%1$d Prüfungen</item>');
    expect(output.get('android/app/src/main/res/values-sv/strings.xml')).toContain('<item quantity="one">%1$d kontroll</item>');
  });

  test('result engines and saved-result translations share the same text', () => {
    const output = renderCatalog(validateCatalog({ origin: {
      en: 'Origin unknown.', de: 'Herkunft unbekannt.', sv: 'Ursprung okänt.', core: ['result.unknownOrigin'], androidResult: ['unknownOrigin'], savedResult: true,
    } }));
    expect(output.get('packages/core/src/i18n.ts')).toContain('"unknownOrigin": "Herkunft unbekannt."');
    expect(output.get('packages/core/src/i18n.ts')).toContain('"unknownOrigin": "Ursprung okänt."');
    expect(output.get('android/app/src/main/java/app/vegsnap/ResultStrings.kt')).toContain('fun unknownOrigin(locale: String): String = when (locale) { "de" -> "Herkunft unbekannt."; "sv" -> "Ursprung okänt."; else -> "Origin unknown." }');
    expect(JSON.parse(output.get('data/result-translations.json')!)).toEqual({ terms: [{ en: 'Origin unknown.', de: 'Herkunft unbekannt.', sv: 'Ursprung okänt.' }] });
  });

  test('rejects missing translations, conflicting keys and damaged placeholders', () => {
    expect(() => validateCatalog({ cancel: { en: 'Cancel', android: ['cancel'] } })).toThrow('Missing translation');
    expect(() => validateCatalog({ cancel: { en: 'Cancel', de: 'Abbrechen', android: ['cancel'] } })).toThrow('Missing translation');
    expect(() => validateCatalog({ account: { en: 'Remove {account}', de: 'Konto entfernen', sv: 'Ta bort {account}', extension: ['app.remove'] } })).toThrow('Formatting arguments');
    expect(() => validateCatalog({ count: { en: '%1$d checks', de: '%1$d Prüfungen', sv: '%1$s kontroller', android: ['count'] } })).toThrow('Formatting arguments');
    expect(() => validateCatalog({ a: { en: 'A', de: 'A', sv: 'A', android: ['same'] }, b: { en: 'B', de: 'B', sv: 'B', android: ['same'] } })).toThrow('Duplicate binding');
    expect(() => validateCatalog({ checks: { en: { one: 'Check', other: 'Checks' }, de: { one: 'Prüfung', other: 'Prüfungen' }, sv: { other: 'kontroller' }, android: ['checks'] } })).toThrow('invalid plurals');
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
