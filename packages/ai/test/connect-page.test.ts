import { expect, test } from 'bun:test';
import { runInNewContext } from 'node:vm';

const script = await Bun.file(new URL('../public/connect.js', import.meta.url)).text();
const html = await Bun.file(new URL('../public/index.html', import.meta.url)).text();
async function page(client: string, verified: boolean) {
  const token = 'a'.repeat(64);
  const status = { textContent: '' };
  const action = { hidden: true };
  let callback: ((challenge: string) => Promise<void>) | undefined;
  let scrubbed = '';
  const calls: { path: string; init?: RequestInit }[] = [];
  runInNewContext(script, {
    URLSearchParams, location: { hash: `#token=${token}&client=${client}`, pathname: '/' },
    history: { replaceState(_state: unknown, _title: string, path: string) { scrubbed = path; } },
    document: {
      querySelector(selector: string) { return selector === '#status' ? status : action; },
      createElement() { return { src: '', onload() {} }; },
      head: { append(element: { onload(): void }) { element.onload(); } },
    },
    window: { turnstile: {
      render(_selector: string, options: { callback: typeof callback }) { callback = options.callback; return 'widget'; },
      remove() {},
    } },
    async fetch(path: string, init?: RequestInit) {
      calls.push({ path, init });
      return path === '/api/config' ? Response.json({ enabled: true, sessionCheckLimit: 3, siteKey: 'test' }) : new Response('{}', { status: verified ? 200 : 400 });
    },
  });
  await new Promise(resolve => setImmediate(resolve));
  expect(action.hidden).toBe(true);
  expect(scrubbed).toBe('/');
  expect(callback).toBeDefined();
  await callback!('test-challenge');
  return { status, action, calls, token };
}
test('verified Android connection offers a fixed app return without credentials', async () => {
  const result = await page('android', true);
  expect(result.action.hidden).toBe(false);
  expect(result.status.textContent).toContain('Connected.');
  expect(result.status.textContent).not.toContain('refresh');
  expect(html).toContain('href="intent://ai/complete#Intent;scheme=vegsnap;package=app.vegsnap;end" hidden');
  expect(result.calls[1]?.init?.headers).toEqual({ 'Content-Type': 'application/json', Authorization: `Bearer ${result.token}` });
});
test('failed verification cannot offer a successful app return', async () => {
  const result = await page('android', false);
  expect(result.action.hidden).toBe(true);
  expect(result.status.textContent).toContain('Verification failed');
});
test('extension connections do not open an unrelated Android app', async () => {
  expect((await page('', true)).action.hidden).toBe(true);
});
