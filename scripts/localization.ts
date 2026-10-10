import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const languages = ['en', 'de'] as const;
type Language = typeof languages[number];
type Plural = { one: string; other: string };
type Translation = string | Plural;
type Platform = 'android' | 'ios' | 'share' | 'extension' | 'core' | 'androidResult';
type Message = Record<Language, Translation> & Partial<Record<Platform, string[]>> & { savedResult?: true };
type Catalog = Record<string, Message>;
const platforms: Platform[] = ['android', 'ios', 'share', 'extension', 'core', 'androidResult'];
const extensionGroups = {
  app: 'messages', company: 'companyMessages', community: 'communityMessages', contact: 'contactMessages',
  store: 'storeMessages', background: 'backgroundMessages',
  market: 'marketMessages',
  alternatives: 'alternativeMessages',
};
const coreGroups = { analysis: 'analysisMessages', result: 'resultMessages' };
const generatedNotice = 'Generated from localization/strings.json by bun run strings:generate. Do not edit.';

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function placeholders(value: string): string[] {
  return [...value.matchAll(/%%|%(?:\d+\$)?[-+0 #]*\d*(?:\.\d+)?[dsf@]|\{[a-zA-Z_][a-zA-Z_0-9]*\}/g)]
    .map(match => match[0]).filter(value => value !== '%%').sort();
}

export function validateCatalog(value: unknown): Catalog {
  if (!record(value) || !Object.keys(value).length) throw new Error('The string catalog must contain messages.');
  const bindings = new Set<string>();
  for (const [id, message] of Object.entries(value)) {
    if (!/^[a-z][a-z0-9_]*$/.test(id) || !record(message)) throw new Error(`Invalid message: ${id}`);
    for (const key of Object.keys(message)) {
      if (![...languages, ...platforms, 'savedResult'].includes(key)) throw new Error(`Unknown field: ${id}.${key}`);
    }
    if (message.savedResult !== undefined && message.savedResult !== true) throw new Error(`Invalid saved-result marker: ${id}`);
    for (const language of languages) {
      const text = message[language];
      if (typeof text === 'string') {
        if (!text.trim()) throw new Error(`Empty translation: ${id}.${language}`);
      } else if (!record(text) || Object.keys(text).sort().join(',') !== 'one,other' ||
          Object.values(text).some(item => typeof item !== 'string' || !item.trim())) {
        throw new Error(`Missing translation or invalid plurals: ${id}.${language}`);
      }
    }
    const en = message.en as Translation, de = message.de as Translation;
    if (typeof en !== typeof de) throw new Error(`Translation type mismatch: ${id}`);
    if (message.savedResult && typeof en !== 'string') throw new Error(`Saved-result text must be a string: ${id}`);
    const pairs = typeof en === 'string' ? [[en, de as string]] :
      (['one', 'other'] as const).map(quantity => [en[quantity], (de as Plural)[quantity]]);
    for (const [english, german] of pairs) {
      if (JSON.stringify(placeholders(english!)) !== JSON.stringify(placeholders(german!))) {
        throw new Error(`Formatting arguments differ between translations: ${id}`);
      }
    }
    let bound = message.savedResult === true;
    for (const platform of platforms) {
      const targets = message[platform];
      if (targets === undefined) continue;
      if (!Array.isArray(targets) || !targets.length || targets.some(target => typeof target !== 'string' || !target.trim())) {
        throw new Error(`Invalid bindings: ${id}.${platform}`);
      }
      if (platform !== 'android' && typeof en !== 'string') throw new Error(`Plurals are only supported for Android: ${id}`);
      for (const target of targets as string[]) {
        if (platform === 'android' && !/^[a-z][a-z0-9_]*$/.test(target)) throw new Error(`Invalid Android resource: ${target}`);
        if (platform === 'androidResult' && !/^[a-z][a-zA-Z0-9]*$/.test(target)) throw new Error(`Invalid Android result binding: ${target}`);
        if (platform === 'extension' || platform === 'core') {
          const [group, key, extra] = target.split('.');
          if (!Object.hasOwn(platform === 'extension' ? extensionGroups : coreGroups, group!) ||
              !/^[a-zA-Z][a-zA-Z0-9_]*$/.test(key ?? '') || extra !== undefined) {
            throw new Error(`Invalid ${platform} binding: ${target}`);
          }
        }
        const binding = `${platform}:${target}`;
        if (bindings.has(binding)) throw new Error(`Duplicate binding: ${binding}`);
        bindings.add(binding);
        bound = true;
      }
    }
    if (!bound) throw new Error(`Message has no platform bindings: ${id}`);
  }
  return value as Catalog;
}

function xml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

export function androidText(value: string): string {
  const escaped = value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll("'", "\\'")
    .replaceAll('\n', '\\n').replaceAll('\t', '\\t');
  // Android otherwise collapses whitespace and treats leading @/? as references.
  return xml(/^\s|\s$| {2}|^[@?]/.test(value) ? `"${escaped}"` : escaped);
}

function swiftText(value: string): string {
  return JSON.stringify(value);
}

export function renderCatalog(catalog: Catalog): Map<string, string> {
  const output = new Map<string, string>();
  const targets = (platform: Platform) => Object.entries(catalog).flatMap(([, message]) =>
    (message[platform] ?? []).map(key => ({ key, message }))).sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  for (const language of languages) {
    const android = targets('android').map(({ key, message }) => {
      const value = message[language];
      return typeof value === 'string' ? `    <string name="${key}">${androidText(value)}</string>` :
        `    <plurals name="${key}">\n${(['one', 'other'] as const).map(quantity =>
          `        <item quantity="${quantity}">${androidText(value[quantity])}</item>`).join('\n')}\n    </plurals>`;
    });
    output.set(`android/app/src/main/res/${language === 'en' ? 'values' : `values-${language}`}/strings.xml`,
      `<?xml version="1.0" encoding="utf-8"?>\n<!-- ${generatedNotice} -->\n<resources>\n${android.join('\n')}\n</resources>\n`);
    for (const platform of ['ios', 'share'] as const) {
      const directory = platform === 'ios' ? 'ios/Vegsnap/Resources' : 'ios/ShareExtension';
      const strings = targets(platform).map(({ key, message }) => `${swiftText(key)} = ${swiftText(message[language] as string)};`);
      output.set(`${directory}/${language}.lproj/Localizable.strings`, `/* ${generatedNotice} */\n${strings.join('\n')}\n`);
    }
  }
  for (const [platform, groups, path] of [
    ['extension', extensionGroups, 'extension/src/i18n.ts'],
    ['core', coreGroups, 'packages/core/src/i18n.ts'],
  ] as const) {
    const entries = targets(platform);
    const dictionaries = Object.entries(groups).map(([group, name]) => {
      const locales = languages.map(language => {
        const strings = entries.filter(({ key }) => key.startsWith(`${group}.`)).map(({ key, message }) =>
          `    ${JSON.stringify(key.split('.')[1])}: ${JSON.stringify(message[language])},`);
        return `  ${language}: {\n${strings.join('\n')}\n  },`;
      });
      return `export const ${name} = {\n${locales.join('\n')}\n};`;
    });
    output.set(path, `// ${generatedNotice}\n${dictionaries.join('\n\n')}\n`);
  }
  const kotlin = (value: Translation) => JSON.stringify(value).replaceAll('$', '\\$');
  const androidResults = targets('androidResult').map(({ key, message }) =>
    `    fun ${key}(german: Boolean): String = if (german) ${kotlin(message.de)} else ${kotlin(message.en)}`);
  output.set('android/app/src/main/java/app/vegsnap/ResultStrings.kt',
    `// ${generatedNotice}\npackage app.vegsnap\n\ninternal object ResultStrings {\n${androidResults.join('\n')}\n}\n`);
  const terms = Object.values(catalog).filter(message => message.savedResult).map(({ en, de }) => ({ en, de }));
  output.set('data/result-translations.json', JSON.stringify({ terms }, null, 2) + '\n');
  return output;
}

export async function generateStrings(check = false): Promise<void> {
  const catalog = validateCatalog(JSON.parse(await readFile(`${root}localization/strings.json`, 'utf8')) as unknown);
  const stale: string[] = [];
  for (const [path, content] of renderCatalog(catalog)) {
    const current = await readFile(`${root}${path}`, 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return '';
      throw error;
    });
    if (current === content) continue;
    if (check) stale.push(path);
    else await writeFile(`${root}${path}`, content);
  }
  if (stale.length) throw new Error(`Generated strings are stale. Run bun run strings:generate:\n${stale.join('\n')}`);
}

if (import.meta.main) {
  if (process.argv.slice(2).some(arg => arg !== '--check')) throw new Error('Usage: bun scripts/localization.ts [--check]');
  await generateStrings(process.argv.includes('--check'));
  console.log(process.argv.includes('--check') ? 'Generated strings are up to date.' : 'Generated UI and result strings for Android, iOS and the extensions.');
}
