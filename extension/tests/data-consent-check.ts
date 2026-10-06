import { mock } from 'bun:test';
import { strict as assert } from 'node:assert';

let scheme = 'moz-extension:';
const granted = new Set<string>();
const requests: { origins?: string[]; permissions?: string[]; data_collection?: string[] }[] = [];
let networkCalls = 0;
let nativeCalls = 0;
mock.module('wxt/browser', () => ({ browser: {
  runtime: { getURL: (path: string) => `${scheme}//fixture${path}`, connectNative() { nativeCalls++; throw new Error('Native process reached'); } },
  permissions: {
    async contains(request: { data_collection?: string[] }) { return (request.data_collection ?? []).every(value => granted.has(value)); },
    async request(request: typeof requests[number]) { requests.push(request); return false; },
  },
} }));
const { CONTENT_DATA, ACCOUNT_DATA, AI_DATA, requestDataConsent, contentFetch, aiFetch } = await import('../src/data-consent');
const { companion } = await import('../src/companion');
const originalFetch = globalThis.fetch;
globalThis.fetch = Object.assign(async () => { networkCalls++; return new Response('{}'); }, { preconnect: originalFetch.preconnect }) as typeof fetch;
try {
  await assert.rejects(() => contentFetch('https://example.invalid'), /Allow data sharing/);
  await assert.rejects(() => aiFetch('https://example.invalid'), /Allow data sharing/);
  await assert.rejects(() => companion('signIn'), /Allow data sharing/);
  assert.equal(networkCalls, 0);
  assert.equal(nativeCalls, 0);
  assert.equal(await requestDataConsent(CONTENT_DATA, { origins: ['https://www.dm.de/*'] }), false);
  assert.deepEqual(requests.at(-1), { origins: ['https://www.dm.de/*'], data_collection: [...CONTENT_DATA] });
  CONTENT_DATA.forEach(value => granted.add(value));
  await contentFetch('https://example.invalid');
  await assert.rejects(() => aiFetch('https://example.invalid'), /Allow data sharing/);
  assert.equal(networkCalls, 1, 'Content consent does not authorize credentials');
  AI_DATA.forEach(value => granted.add(value));
  await aiFetch('https://example.invalid');
  ACCOUNT_DATA.forEach(value => granted.add(value));
  await assert.rejects(() => companion('status'), /Native process reached/);
  assert.equal(nativeCalls, 1);
  granted.delete('websiteContent');
  await assert.rejects(() => contentFetch('https://example.invalid'), /Allow data sharing/);
  await assert.rejects(() => aiFetch('https://example.invalid'), /Allow data sharing/);
  await assert.rejects(() => companion('check', { text: 'private fixture' }), /Allow data sharing/);
  assert.equal(networkCalls, 2, 'Revocation prevents further network requests');
  assert.equal(nativeCalls, 1, 'Revocation prevents selected content reaching a native process');
  scheme = 'chrome-extension:';
  await contentFetch('https://example.invalid');
  await requestDataConsent(AI_DATA, { origins: ['https://api.example.invalid/*'] });
  assert.deepEqual(requests.at(-1), { origins: ['https://api.example.invalid/*'] }, 'Firefox-only permission fields never reach Chrome');
  console.log('Data consent: no network/native transmission before opt-in or after revocation; Chrome host requests preserved');
} finally { globalThis.fetch = originalFetch; }
