// Exercise the real Browse form: paced database searches, paging, drafting into Scan, and the offline-pack fallback.
import { mock } from 'bun:test';
import { strict as assert } from 'node:assert';
import { Window } from 'happy-dom';
import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import { defaultSettings } from '../src/settings';
import type { BrowsePage, BrowseSearch, CheckInput } from '@vegsnap/core';

const window = new Window({ url: 'https://vegsnap.test' });
const document = window.document as unknown as Document;
Object.assign(globalThis, { window, document, location: window.location, navigator: window.navigator, Event: window.Event });
let consent = true;
const permissionListeners = new Set<() => void>();
mock.module('wxt/browser', () => ({ browser: { runtime: { getURL: () => 'moz-extension://fixture/' },
  permissions: { onRemoved: { addListener: (fn: () => void) => permissionListeners.add(fn), removeListener: (fn: () => void) => permissionListeners.delete(fn) }, contains: async () => consent, request: async () => consent } } }));
const originalFetch = globalThis.fetch;
const now = Date.now;
let clock = now();
Date.now = () => clock += 7000; // Submitted-search pacing is covered in core; no wall-clock waits here.
const urls: URL[] = [];
let status = 200, networkDown = false, hold = false;
let release: ((response: Response) => void) | undefined;
const products = (page: number) => Array.from({ length: page === 3 ? 5 : 20 }, (_, index) => ({ code: page === 1 && index === 0 ? '4006381333931' : `40${page}${String(index).padStart(10, '0')}`,
  product_name: `Oat drink ${page}-${index}`, brands: 'Plant', ingredients_text: 'water, oats', countries_tags: ['en:germany'], quantity: '1 l', last_modified_t: 1760000000 }));
globalThis.fetch = Object.assign(async (url: string | URL | Request) => {
  const request = new URL(String(url)); urls.push(request);
  if (hold) return new Promise<Response>(resolve => { release = resolve; });
  if (networkDown) throw new TypeError('fetch failed');
  if (status !== 200) return new Response('', { status });
  return Response.json({ count: 45, products: products(Number(request.searchParams.get('page'))) });
}, { preconnect: originalFetch.preconnect });
const { Browse } = await import('../src/browse');
const root = document.createElement('div'); document.body.append(root);
const offlineRequests: BrowseSearch[] = [];
const drafts: CheckInput[] = [];
const offlineSearch = async (input: BrowseSearch): Promise<BrowsePage> => {
  offlineRequests.push(input);
  return { offline: true, records: [{ id: '7310865004703', source: input.source, name: 'Offline oat drink', barcode: '7310865004703', brand: 'Pack', composition: 'water, oats', markets: 'sweden',
    countryTags: ['en:sweden'], quantity: '', labels: '', updated: '2025-10-09', url: 'https://world.openfoodfacts.org/product/7310865004703', snapshotDate: '2026-10-05T10:00:00Z' }] };
};
async function flush() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); }); }
async function until(predicate: () => boolean, description: string) {
  for (let i = 0; i < 50; i++) { await flush(); if (predicate()) return; }
  assert(predicate(), description);
}
async function submit() { await act(async () => { root.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); }); }
async function type(value: string) { const query = root.querySelector<HTMLInputElement>('input')!; await act(async () => { query.value = value; query.dispatchEvent(new Event('input', { bubbles: true })); }); }
const buttons = () => [...root.querySelectorAll<HTMLButtonElement>('button')];
const button = (label: string) => buttons().find(item => item.textContent === label)!;
const records = () => root.querySelectorAll('.browse-record');
try {
  await act(async () => { render(h(Browse, { config: defaultSettings, offlineSearch, onUse: input => drafts.push(input) }, h('p', { class: 'fixture-child' }, 'Alternatives fixture')), root); });
  await flush();
  assert(root.querySelector('.fixture-child'), 'The Browse tab hosts the alternatives search');
  assert(root.textContent?.includes('Community-maintained information'), 'Records are described as community drafts');
  assert(root.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled, 'Search needs at least two characters');
  await type('oat drink');
  assert(!root.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled);
  await submit();
  await until(() => records().length === 20, 'The first page lists twenty records');
  assert(root.textContent?.includes('Results for “oat drink”') && root.textContent.includes('Page 1'));
  assert.equal(urls.length, 1);
  assert.equal(urls[0]!.origin, 'https://world.openfoodfacts.org');
  assert.equal(urls[0]!.searchParams.get('search_terms'), 'oat drink');
  assert.equal(urls[0]!.searchParams.get('page'), '1');
  assert.equal(urls[0]!.searchParams.get('page_size'), '20');
  assert(button('Previous').disabled && !button('Next').disabled);
  await act(async () => { button('Next').click(); });
  await until(() => root.textContent?.includes('Page 2') === true, 'Next requests the second page');
  assert.equal(urls[1]!.searchParams.get('page'), '2');
  await act(async () => { button('Next').click(); });
  await until(() => root.textContent?.includes('Page 3') === true, 'Next requests the third page');
  assert.equal(records().length, 5);
  assert(button('Next').disabled, 'The reported count ends paging');
  await act(async () => { button('Previous').click(); });
  await until(() => root.textContent?.includes('Page 2') === true, 'Previous returns to the second page');
  assert.equal(urls.length, 3, 'A revisited page comes from the cache');
  assert(root.textContent?.includes('Open Food Facts · ODbL-1.0'), 'Each record names its source and license');
  await act(async () => { button('Previous').click(); });
  await until(() => root.textContent?.includes('Page 1') === true, 'Previous returns to the first page');
  await act(async () => { button('Use in Scan').click(); });
  assert.deepEqual(drafts, [{ text: 'water, oats', name: 'Oat drink 1-0', brand: 'Plant', barcode: '4006381333931', category: 'food', complete: false }], 'A record hands over an editable draft');
  const select = root.querySelector<HTMLSelectElement>('select')!;
  await act(async () => { select.value = 'obf'; select.dispatchEvent(new Event('change', { bubbles: true })); });
  await flush();
  assert.equal(records().length, 0, 'Changing the database clears old results');
  status = 429; await submit();
  await until(() => root.textContent?.includes('request limit') === true, 'Rate limits are explained');
  assert.equal(urls.at(-1)!.origin, 'https://world.openbeautyfacts.org');
  assert.equal(offlineRequests.length, 0, 'A reachable but limited database does not fall back to offline packs');
  status = 503; await type('oat outage'); await submit();
  await until(() => offlineRequests.length === 1, 'A database outage falls back to offline packs');
  assert(root.textContent?.includes('temporarily unavailable') && root.textContent.includes('Offline oat drink'));
  status = 200; networkDown = true;
  await type('oat pack'); await submit();
  await until(() => offlineRequests.length === 2, 'An unreachable database falls back to offline packs');
  assert(root.textContent?.includes('Could not connect to the database') && root.textContent.includes('limited selection of public product records') && root.textContent.includes('Offline snapshot: 2026-10-05'));
  assert.deepEqual(offlineRequests.at(-1), { source: 'obf', query: 'oat pack', cursor: 0, locale: 'en' });
  networkDown = false; consent = false;
  const requestsBefore = urls.length;
  await submit();
  await until(() => offlineRequests.length === 3, 'Declined data sharing also answers from offline packs');
  assert.equal(urls.length, requestsBefore, 'No network request without data sharing');
  assert(root.textContent?.includes('Allow data sharing to search.'));
  consent = true; hold = true;
  await type('held search'); await submit();
  await until(() => !!release, 'The held search started');
  await act(async () => { button('Cancel').click(); });
  assert.equal(root.querySelector('section')?.getAttribute('aria-busy'), 'false');
  await act(async () => { release!(Response.json({ count: 1, products: [{ code: '12345678', product_name: 'Stale record' }] })); });
  await flush();
  assert(!root.textContent?.includes('Stale record'), 'A cancelled search never shows late results');
  hold = false; release = undefined;
  console.log('Browse UI: submitted search, paging, cache, draft hand-off, rate limit, outage/offline fallback, consent and cancellation verified');
} finally {
  await act(() => render(null, root)); assert.equal(permissionListeners.size, 0, 'Unmount removes the revocation listener'); globalThis.fetch = originalFetch; Date.now = now; await window.happyDOM.close();
}
