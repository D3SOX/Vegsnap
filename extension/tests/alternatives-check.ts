// Exercise the real search form, including public-first results, AI failure, and stale completion.
import { mock } from 'bun:test';
import { strict as assert } from 'node:assert';
import { Window } from 'happy-dom';
import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import fixtures from '../../contracts/alternatives-fixtures.json';
import { defaultSettings } from '../src/settings';
import type { AlternativeSearch, VeganAlternative } from '@vegsnap/core';

const window = new Window({ url: 'https://vegsnap.test' });
const document = window.document as unknown as Document;
Object.assign(globalThis, { window, document, location: window.location, navigator: window.navigator, Event: window.Event });
let consent = true, consentRequests = 0;
mock.module('wxt/browser', () => ({ browser: { runtime: { getURL: () => 'moz-extension://fixture/' },
  permissions: { contains: async () => true, request: async () => { consentRequests++; return consent; } } } }));
const originalFetch = globalThis.fetch;
const now = Date.now;
let clock = now(), failPublic = false;
Date.now = () => clock += 7000; // Submitted-search pacing is covered separately; no wall-clock waits here.
const urls: URL[] = [];
globalThis.fetch = Object.assign(async (url: string | URL | Request) => {
  urls.push(new URL(String(url)));
  if (failPublic) throw new Error('Fixture public outage');
  return Response.json(fixtures.document);
}, { preconnect: originalFetch.preconnect });
const { Alternatives } = await import('../src/alternatives');
const root = document.createElement('div'); document.body.append(root);
let calls = 0;
let failAI = true;
let completeAI: ((value: VeganAlternative[]) => void) | undefined;
let activeAISignal: AbortSignal | undefined;
const research = async (_input: AlternativeSearch, signal: AbortSignal) => {
  activeAISignal = signal;
  calls++;
  if (failAI) throw new Error('Fixture AI outage');
  return new Promise<VeganAlternative[]>(resolve => { completeAI = resolve; });
};
async function flush() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); }); }
async function until(predicate: () => boolean) {
  for (let i = 0; i < 50; i++) { await flush(); if (predicate()) return; }
  assert(predicate());
}
async function submit() { await act(async () => { root.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); }); }
try {
  await act(async () => { render(h(Alternatives, { config: { ...defaultSettings, connection: 'chatgpt', model: 'fixture' }, researchEnabled: true, market: 'DE', excludeBarcode: fixtures.input.excludeBarcode, initialQuery: 'chocolate', research }), root); });
  await flush();
  const retailer = root.querySelectorAll<HTMLInputElement>('input')[1]!;
  await act(async () => { retailer.value = 'REWE'; retailer.dispatchEvent(new Event('input', { bubbles: true })); });
  await submit();
  await until(() => root.textContent?.includes('AI research unavailable.') === true);
  assert.equal(calls, 1);
  assert.equal(consentRequests, 1, 'One permission request covers public and AI research');
  assert(root.textContent?.includes('Listed at REWE, dm — likely available'));
  assert(root.textContent?.includes('Store availability unknown'));
  assert(!root.textContent?.includes('Milk chocolate'));
  assert(urls.some(url => url.searchParams.get('tag_1') === 'REWE'));
  assert(urls.some(url => !url.searchParams.has('tag_1')));
  assert.equal(root.querySelectorAll('.evidence').length, 3);
  consent = false;
  await submit(); await until(() => root.getAttribute('aria-busy') === 'false' || root.querySelector('section')?.getAttribute('aria-busy') === 'false');
  assert.equal(calls, 1, 'Declined AI sharing still keeps previously allowed public search');
  assert.equal(root.querySelectorAll('.evidence').length, 3);
  consent = true; failAI = false;
  await submit(); await until(() => !!completeAI);
  assert(root.textContent?.includes('Dark chocolate'), 'Public records remain displayed during AI research');
  const cancel = [...root.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Cancel')!;
  await act(async () => { cancel.click(); });
  assert.equal(activeAISignal?.aborted, true, 'Cancellation reaches AI research');
  await act(async () => { completeAI!([{ id: 'late', name: 'Stale AI result', brand: 'Plant', url: 'https://example.invalid', source: 'AI', evidence: 'vegan', storeMatch: false, stores: [], marketListed: false }]); });
  await flush(); assert(!root.textContent?.includes('Stale AI result'));
  await act(async () => { render(h(Alternatives, { config: { ...defaultSettings, connection: 'database' }, market: 'SE', excludeBarcode: fixtures.input.excludeBarcode, initialQuery: 'chocolate', research }), root); });
  await flush(); assert.equal(root.querySelectorAll('.evidence').length, 0, 'Changing country clears old alternatives');
  const before = calls;
  const query = root.querySelector<HTMLInputElement>('input')!;
  await act(async () => { query.value = 'uncached query'; query.dispatchEvent(new Event('input', { bubbles: true })); });
  failPublic = true; await submit(); await until(() => root.textContent?.includes('Fixture public outage') === true);
  assert.equal(calls, before, 'Database-only search never calls AI');
  console.log('Alternative UI: optional-store query, public-first ranking, AI failure preservation, cancellation and country reset verified');
} finally {
  render(null, root); globalThis.fetch = originalFetch; Date.now = now; await window.happyDOM.close();
}
