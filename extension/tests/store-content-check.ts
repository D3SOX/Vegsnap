// Isolated process: browser mocks must not leak into the pure discovery tests.
import { mock } from 'bun:test';
import { strict as assert } from 'node:assert';
import { Window as HappyWindow } from 'happy-dom';

const window = new HappyWindow({ url: 'https://www.amazon.de/s?k=oat' });
const document = window.document as unknown as Document;
const domWindow = window as unknown as Window;
const messages: Record<string, unknown>[] = [];
type RuntimeListener = (message: unknown, sender: { id?: string }) => void;
const runtimeListeners = new Set<RuntimeListener>();
let respond: (message: Record<string, unknown>) => Promise<unknown> = async () => ({ ok: false, error: 'No database answer' });
class VisibilityObserver {
  static instances: VisibilityObserver[] = [];
  observed = new Set<Element>();
  disconnected = false;
  constructor(readonly callback: (entries: { target: Element; isIntersecting: boolean }[]) => void) { VisibilityObserver.instances.push(this); }
  observe(target: Element) { this.observed.add(target); }
  unobserve(target: Element) { this.observed.delete(target); }
  disconnect() { this.disconnected = true; this.observed.clear(); }
  show(target: Element) { if (this.observed.has(target)) this.callback([{ target, isIntersecting: true }]); }
}
Object.assign(globalThis, { window, document, location: window.location, MutationObserver: window.MutationObserver, IntersectionObserver: VisibilityObserver });
const domListeners = new Set<{ target: EventTarget; type: string; listener: EventListenerOrEventListenerObject }>();
for (const target of [document, domWindow]) {
  const add = target.addEventListener.bind(target), remove = target.removeEventListener.bind(target);
  target.addEventListener = (type: string, listener: EventListenerOrEventListenerObject | null, options?: AddEventListenerOptions | boolean) => {
    if (listener && ['change', 'popstate', 'wxt:locationchange'].includes(type) && ![...domListeners].some(entry => entry.target === target && entry.type === type && entry.listener === listener)) domListeners.add({ target, type, listener });
    if (listener) add(type, listener, options);
  };
  target.removeEventListener = (type: string, listener: EventListenerOrEventListenerObject | null, options?: EventListenerOptions | boolean) => {
    for (const entry of domListeners) if (entry.target === target && entry.type === type && entry.listener === listener) domListeners.delete(entry);
    if (listener) remove(type, listener, options);
  };
}
type TestContext = { abort(): void; addEventListener(target: EventTarget, type: string, listener: EventListener): void; onInvalidated(callback: () => void): void };
function context() {
  const invalidated: (() => void)[] = [];
  let aborted = false;
  const ctx: TestContext = {
    abort() { if (aborted) return; aborted = true; for (const callback of invalidated) callback(); },
    addEventListener(target, type, listener) { target.addEventListener(type, listener); invalidated.push(() => target.removeEventListener(type, listener)); },
    onInvalidated(callback) { invalidated.push(callback); },
  };
  return { ctx, invalidate() { ctx.abort(); } };
}
mock.module('wxt/browser', () => ({ browser: {
  i18n: { getUILanguage: () => 'en-GB' },
  runtime: { id: 'veguide', async sendMessage(message: Record<string, unknown>) { messages.push(message); return respond(message); }, onMessage: { addListener(listener: RuntimeListener) { runtimeListeners.add(listener); }, removeListener(listener: RuntimeListener) { runtimeListeners.delete(listener); } } },
} }));
mock.module('wxt/utils/define-content-script', () => ({ defineContentScript: (definition: unknown) => definition }));
const { default: definition } = await import('../entrypoints/store.content');
const script = definition as unknown as { main(ctx: TestContext): void };
const fixture = (name: string) => Bun.file(new URL(`fixtures/stores/${name}.html`, import.meta.url)).text();
const badges = () => [...document.querySelectorAll<HTMLElement>('[data-veguide-badge]')];
const button = (host: HTMLElement) => host.shadowRoot!.querySelector<HTMLButtonElement>('button')!;
const settle = () => new Promise(resolve => setTimeout(resolve, 0));
try {
  document.body.innerHTML = await fixture('amazon');
  document.body.insertAdjacentHTML('beforeend', '<script type="application/ld+json">{"@type":"Product","name":"Example Oat Drink 1L","brand":"Example Brand","url":"https://www.amazon.de/dp/B0ABC12345"}</script>');
  const first = context(); script.main(first.ctx);
  assert.equal(badges().length, 2, 'Amazon cards without barcodes still show explicit check buttons');
  assert(badges().every(host => button(host).textContent === 'Veguide · Check'));
  assert(badges().every(host => !host.closest('a')), 'Check buttons are never nested in store product links');
  assert.equal(messages.length, 0, 'Barcodeless cards do not start background lookups');
  button(badges()[0]!).click();
  assert.deepEqual(messages.at(-1), { type: 'open-check', barcode: undefined, name: 'Example Oat Drink 1L', brand: 'Example Brand', sourceUrl: 'https://www.amazon.de/dp/B0ABC12345' });
  assert.equal(messages.filter(message => message.type === 'background-check').length, 0);

  const oldHost = badges()[0]!;
  const oldButton = button(oldHost);
  const oldObserver = VisibilityObserver.instances.at(-1)!;
  const beforeListeners = domListeners.size;
  const second = context(); script.main(second.ctx);
  assert.equal(badges().length, 2, 'Reinjection replaces badges without duplicates');
  assert(!oldHost.isConnected);
  assert(oldObserver.disconnected);
  assert.equal(runtimeListeners.size, 1, 'Reinjection removes the prior runtime listener');
  assert.equal(domListeners.size, beforeListeners, 'Reinjection removes prior DOM rescan listeners');
  const beforeOldClick = messages.length;
  oldButton.click();
  assert.equal(messages.length, beforeOldClick, 'Detached old buttons cannot dispatch a product check');
  first.invalidate();
  assert.equal(badges().length, 2, 'Invalidating an old context leaves the current instance intact');
  for (const listener of runtimeListeners) listener({ type: 'veguide-store-disabled' }, { id: 'other-extension' });
  assert.equal(badges().length, 2, 'An unrelated runtime sender cannot disable the integration');
  for (const listener of [...runtimeListeners]) listener({ type: 'veguide-store-disabled' }, { id: 'veguide' });
  assert.equal(badges().length, 0);
  assert.equal(runtimeListeners.size, 0);
  assert.equal(domListeners.size, 0, 'Disabling removes DOM listeners as well as badges');
  second.invalidate();

  window.happyDOM.setURL('https://www.dm.de/search?query=hafer');
  document.body.innerHTML = await fixture('dm-current');
  let completeLookup: ((response: unknown) => void) | undefined;
  respond = message => message.type === 'background-check' ? new Promise(resolve => { completeLookup = resolve; }) : Promise.resolve({ ok: true, result: null });
  const third = context(); script.main(third.ctx);
  const dmHost = badges()[0]!;
  assert(dmHost);
  assert.equal(messages.filter(message => message.type === 'background-check').length, 0, 'Offscreen products wait before a database lookup');
  VisibilityObserver.instances.at(-1)!.show(dmHost);
  await settle();
  assert.deepEqual(messages.at(-1), { type: 'background-check', barcode: '4070765022841' }, 'Visible GTIN products request only a barcode database check');
  button(dmHost).click();
  assert.deepEqual(messages.at(-1), { type: 'open-check', barcode: '4070765022841', name: 'Haferdrink Barista, 1 l', brand: 'dmBio', sourceUrl: 'https://www.dm.de/p/d/1697279/dmbio-haferdrink-barista' });
  const oldLabel = button(dmHost).textContent;
  const tile = document.querySelector('[data-dmid="product-tile"]')!;
  tile.setAttribute('data-gtin', '4006381333931');
  document.querySelector('[data-dmid="product-description"] a')!.textContent = 'Replacement product';
  assert(completeLookup);
  completeLookup({ ok: true, result: { identity: { match: 'exact_barcode' }, title: 'Old product is vegan', summary: 'Old database evidence' } });
  await settle();
  assert.equal(button(dmHost).textContent, oldLabel, 'A late response cannot apply to a recycled product card');
  const beforeStaleClick = messages.length;
  button(dmHost).click();
  assert.equal(messages.length, beforeStaleClick, 'A stale badge click cannot open the previous product');
  assert(!dmHost.isConnected, 'The stale click immediately refreshes the binding');
  assert.equal(badges().length, 1);
  button(badges()[0]!).click();
  assert.equal(messages.at(-1)?.name, 'Replacement product');
  assert.equal(messages.at(-1)?.barcode, '4006381333931');
  third.invalidate();
  assert.equal(badges().length, 0);
  assert.equal(runtimeListeners.size, 0);
  assert.equal(domListeners.size, 0);
  console.log('Content lifecycle: explicit product buttons, visible database-only checks, late-result rejection, reinjection and disable cleanup verified');
} finally {
  const shared = globalThis as typeof globalThis & { __veguideStoreCleanup?: () => void };
  shared.__veguideStoreCleanup?.();
  await window.happyDOM.close();
}
