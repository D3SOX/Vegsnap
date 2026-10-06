import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import fixtures from './fixtures.json';

const output = resolve(process.argv[2] ?? 'artifacts/screenshots');
const extension = resolve('extension/.output/chrome-mv3');
const context = await chromium.launchPersistentContext('', {
  channel: 'chromium', headless: true,
  args: ['--disable-gpu', `--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  viewport: { width: 760, height: 880 }, deviceScaleFactor: 1,
  locale: 'en-US', timezoneId: 'UTC', reducedMotion: 'reduce',
});
try {
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  const page = await context.newPage();
  await page.goto(`chrome-extension://${new URL(worker.url()).hostname}/app.html`);
  await page.evaluate(async results => {
    const chrome = (globalThis as typeof globalThis & {
      chrome: { storage: { local: { set(value: unknown): Promise<void> } } };
    }).chrome;
    await chrome.storage.local.set({ settings: { language: 'en', connection: 'database', saveHistory: true } });
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('vegsnap', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('checks', { keyPath: 'id' });
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction('checks', 'readwrite');
      const store = transaction.objectStore('checks');
      store.clear();
      for (const result of results) store.put(result);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
    db.close();
  }, fixtures.results);
  // All displayed results are fixtures. Capture never contacts a provider or product database.
  await context.setOffline(true);
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await page.reload();
    const folder = join(output, 'website/images', theme === 'dark' ? 'dark/screenshots' : 'screenshots');
    await mkdir(folder, { recursive: true });
    const capture = async (name: string) => {
      await page.evaluate(async () => { window.scrollTo(0, 0); await document.fonts.ready; });
      await page.screenshot({ path: join(folder, `extension-${name}.png`), animations: 'disabled' });
    };
    await page.getByRole('textbox', { name: 'Ingredients, materials or product details' }).fill(`Ingredients: ${fixtures.input.text}`);
    await page.getByRole('combobox', { name: 'Product category' }).selectOption(fixtures.input.category);
    await page.getByRole('checkbox').check();
    await page.waitForFunction(() => document.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled === false);
    await page.getByRole('heading', { name: 'Scan', exact: true }).click();
    await capture('check');
    await page.getByRole('button', { name: /^History/ }).click();
    await page.getByRole('button', { name: /^Honey granola / }).waitFor({ state: 'visible' });
    await capture('history');
    await page.getByRole('button', { name: /^Honey granola / }).click();
    await page.getByRole('img', { name: 'Animal-derived ingredient', exact: true }).waitFor({ state: 'visible' });
    await capture('result');
    await page.getByRole('button', { name: /^History/ }).click();
    await page.getByRole('button', { name: /^Hand cream / }).click();
    await page.getByRole('img', { name: 'Ingredient origin unclear', exact: true }).waitFor({ state: 'visible' });
    await capture('uncertain');
  }
} finally {
  await context.close();
}
console.log('Captured eight extension screenshots.');
