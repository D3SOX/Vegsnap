// Updates versions Dependabot cannot track. Prints a short summary such as "Rust to 1.99.0" when a file changed,
// and nothing when the pin is current. Usage: bun scripts/update-pins.ts rust|swiftlint|tessdata
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { $ } from 'bun';

const root = fileURLToPath(new URL('../', import.meta.url));
// Workflow files cannot be pushed with GITHUB_TOKEN, so the workflows read these pins from here.
const PINS_FILE = '.github/pins.env';
const OCR_FILE = 'android/app/src/main/java/app/vegsnap/OcrLanguages.kt';
const TESSDATA_DIR = 'android/app/src/main/assets/tessdata';

const latestRelease = async (repo: string) => (await $`gh release view --repo ${repo} --json tagName --jq .tagName`.text()).trim();
const version = (value: string) => {
  if (!/^\d+\.\d+\.\d+$/.test(value)) throw new Error(`Unexpected version: ${value}`);
  return value;
};

async function edit(path: string, change: (text: string) => string): Promise<boolean> {
  const before = await readFile(root + path, 'utf8');
  const after = change(before);
  if (after !== before) await writeFile(root + path, after);
  return after !== before;
}

async function pin(key: string, name: string, repo: string): Promise<string | undefined> {
  const latest = version(await latestRelease(repo));
  const line = new RegExp(`^${key}=.*$`, 'm');
  if (!line.test(await readFile(root + PINS_FILE, 'utf8'))) throw new Error(`${key} not found in ${PINS_FILE}.`);
  return await edit(PINS_FILE, text => text.replace(line, `${key}=${latest}`)) ? `${name} to ${latest}` : undefined;
}
const rust = () => pin('RUST_TOOLCHAIN', 'Rust', 'rust-lang/rust');
const swiftlint = () => pin('SWIFTLINT_VERSION', 'SwiftLint', 'realm/SwiftLint');

async function tessdata(): Promise<string | undefined> {
  const revision = (await $`gh api repos/tesseract-ocr/tessdata_fast/commits/main --jq .sha`.text()).trim();
  if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error(`Unexpected revision: ${revision}`);
  let source = await readFile(root + OCR_FILE, 'utf8');
  if (source.includes(`OCR_MODEL_REVISION = "${revision}"`)) return;
  source = source.replace(/(OCR_MODEL_REVISION = ")[a-f0-9]{40}"/, `$1${revision}"`);
  // Refresh each model's size and hash; bundled models are also replaced in the APK assets.
  const rows = [...source.matchAll(/OcrLanguage\("(\w+)", (?:"[^"]*", ){2}(\d+), "([a-f0-9]{64})"(, true)?\)/g)];
  if (!rows.length) throw new Error('OCR language table not found.');
  for (const [row, code, , , bundled] of rows) {
    const response = await fetch(`https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/${revision}/${code}.traineddata`);
    if (!response.ok) throw new Error(`Cannot download ${code}: HTTP ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const hash = createHash('sha256').update(bytes).digest('hex');
    source = source.replace(row, row.replace(/\d+, "[a-f0-9]{64}"/, `${bytes.length}, "${hash}"`));
    if (bundled) await writeFile(`${root}${TESSDATA_DIR}/${code}.traineddata`, bytes);
  }
  await writeFile(root + OCR_FILE, source);
  return `Tesseract models to tessdata_fast@${revision.slice(0, 7)}`;
}

const updaters = { rust, swiftlint, tessdata } as const;
const name = process.argv[2];
if (!name || !Object.hasOwn(updaters, name)) throw new Error(`Usage: bun scripts/update-pins.ts ${Object.keys(updaters).join('|')}`);
const summary = await updaters[name as keyof typeof updaters]();
if (summary) console.log(summary);
