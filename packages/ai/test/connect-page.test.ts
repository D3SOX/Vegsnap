import { expect, test } from 'bun:test';
import { runInNewContext } from 'node:vm';

const script = await Bun.file(new URL('../public/connect.js', import.meta.url)).text();
const html = await Bun.file(new URL('../public/index.html', import.meta.url)).text();
async function page(client: string, verified: boolean | Response) {
  const token = 'a'.repeat(64);
  const status = { textContent: '' };
  const action = { hidden: true, href: "" };
  let callback: ((challenge: string) => Promise<void>) | undefined;
  let expire: (() => void) | undefined;
  let resets = 0;
  let removed = 0;
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
      render(_selector: string, options: { callback: typeof callback; 'expired-callback': () => void }) { callback = options.callback; expire = options['expired-callback']; return 'widget'; },
      reset(widget: string) { expect(widget).toBe('widget'); resets++; },
      remove() { removed++; },
    } },
    async fetch(path: string, init?: RequestInit) {
      calls.push({ path, init });
      return path === '/api/config' ? Response.json({ enabled: true, sessionCheckLimit: 3, siteKey: 'test' }) : verified instanceof Response ? verified.clone() : new Response('{}', { status: verified ? 200 : 400 });
    },
  });
  await new Promise(resolve => setImmediate(resolve));
  expect(action.hidden).toBe(true);
  expect(scrubbed).toBe('/');
  expect(callback).toBeDefined();
  await callback!('test-challenge');
  return { status, action, calls, token, retry: () => { verified = true; return callback!('fresh-challenge'); }, expire: () => expire!(), resets: () => resets, removed: () => removed };
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
  expect(result.resets()).toBe(1);
  await result.retry();
  expect(result.action.hidden).toBe(false);
  expect(result.removed()).toBe(1);
  expect(JSON.parse(String(result.calls.at(-1)?.init?.body))).toEqual({ challenge: 'fresh-challenge' });
});
test('expired challenges reset the widget and can be verified without reloading', async () => {
  const result = await page('android', false);
  result.expire();
  expect(result.resets()).toBe(2);
  expect(result.status.textContent).toContain('Verification expired');
  await result.retry();
  expect(result.action.hidden).toBe(false);
});
test('non-JSON verification failure shows a useful fallback without exposing a parse error', async () => {
  const result = await page('android', new Response('<html>Proxy failure</html>', { status: 502 }));
  expect(result.action.hidden).toBe(true);
  expect(result.status.textContent).toBe('Verification failed or expired. Start again in Vegsnap.');
});
test('verification failure preserves the service retry message', async () => {
  const result = await page('android', Response.json({ error: { message: 'Verification could not be checked. Please verify again.' } }, { status: 502 }));
  expect(result.action.hidden).toBe(true);
  expect(result.status.textContent).toBe('Verification could not be checked. Please verify again.');
});
test('extension connections do not open an unrelated Android app', async () => {
  expect((await page('', true)).action.hidden).toBe(true);
});

test('verified iOS connection offers only its fixed credential-free app return', async () => {
  const result = await page('ios', true);
  expect(result.action.hidden).toBe(false);
  expect(result.action.href).toBe('vegsnap-ios://ai/complete');
  expect(result.action.href).not.toContain(result.token);
  expect((await page('ios', false)).action.hidden).toBe(true);
  expect((await page('https://attacker.invalid', true)).action.hidden).toBe(true);
});
