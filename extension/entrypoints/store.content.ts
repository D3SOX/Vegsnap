import { browser } from 'wxt/browser';
import { storeMessages } from '../src/i18n';
import { defineContentScript } from 'wxt/utils/define-content-script';
import type { CheckResult } from '@vegsnap/core';
import { discoverStoreProducts, isCurrentProductBinding, type ProductBinding } from '../src/store-products';
import type { Reply } from '../src/protocol';

export default defineContentScript({
  matches: [],
  registration: 'runtime',
  main(ctx) {
    // Enabling a site also injects into open tabs. Replace an earlier instance cleanly.
    const shared = globalThis as typeof globalThis & { __vegsnapStoreCleanup?: () => void };
    shared.__vegsnapStoreCleanup?.();
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let queue = Promise.resolve();
    const badges = new Map<HTMLElement, ProductBinding>();
    const t = storeMessages[/^de/i.test(browser.i18n.getUILanguage()) ? 'de' : 'en'];
    const checkLabel = t.check;
    const current = (host: HTMLElement, binding: ProductBinding) => active && host.isConnected && badges.get(host) === binding && isCurrentProductBinding(binding, location.href);
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) if (entry.isIntersecting) {
        observer.unobserve(entry.target);
        const host = entry.target as HTMLElement;
        const binding = badges.get(host);
        if (!binding?.product.barcode) continue;
        queue = queue.then(async () => {
          if (!current(host, binding)) return;
          const label = host.shadowRoot?.querySelector('span');
          if (label) label.textContent = t.checking;
          try {
            const response = await browser.runtime.sendMessage({ type: 'background-check', barcode: binding.product.barcode }) as Reply<CheckResult>;
            if (!current(host, binding)) return;
            if (label) label.textContent = response.ok && response.result.identity.match === 'exact_barcode' ? `Vegsnap · ${response.result.title}` : checkLabel;
            host.title = response.ok && response.result.identity.match === 'exact_barcode' ? response.result.summary : t.inconclusive;
          } catch { if (label && current(host, binding)) label.textContent = checkLabel; }
          await new Promise(resolve => setTimeout(resolve, 1600));
        }).catch(() => {});
      }
    });
    function remove(host: HTMLElement) { observer.unobserve(host); badges.delete(host); host.remove(); }
    function attach(binding: ProductBinding) {
      const host = document.createElement('div'); host.dataset.vegsnapBadge = '';
      const shadow = host.attachShadow({ mode: 'open' });
      const style = document.createElement('style');
      style.textContent = ':host{display:block;margin:6px 0;font:13px/1.4 system-ui;color:#234536}button{font:inherit;color:inherit;background:#edf5e9;border:1px solid #a3b89b;border-radius:12px;padding:8px 12px;cursor:pointer;min-height:44px;text-align:left}button:hover{background:#dfebd9}button:focus-visible{outline:2px solid #234536;outline-offset:2px}';
      const button = document.createElement('button'); button.type = 'button';
      const label = document.createElement('span'); label.textContent = checkLabel; button.append(label);
      button.addEventListener('click', event => {
        event.preventDefault(); event.stopPropagation();
        if (!current(host, binding)) { scan(); return; }
        void browser.runtime.sendMessage({ type: 'open-check', barcode: binding.product.barcode, name: binding.product.name, brand: binding.product.brand, sourceUrl: binding.product.url });
      });
      shadow.append(style, button);
      // Never nest a button inside a store's product link.
      (binding.anchor.closest('a') ?? binding.anchor).insertAdjacentElement('afterend', host);
      badges.set(host, binding);
      if (binding.product.barcode) observer.observe(host);
    }
    function scan() {
      if (!active) return;
      const found = discoverStoreProducts(document, location.href);
      for (const [host, binding] of badges) if (!host.isConnected || !found.some(next => next.anchor === binding.anchor && next.identity === binding.identity)) remove(host);
      for (const binding of found) if (![...badges.values()].some(existing => existing.anchor === binding.anchor && existing.identity === binding.identity)) attach(binding);
    }
    const mutations = new MutationObserver(() => { clearTimeout(timer); timer = setTimeout(scan, 250); });
    mutations.observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['href', 'data-asin', 'data-gtin', 'value'] });
    const rescan = () => { scan(); };
    const disabled = (message: unknown, sender: { id?: string }) => {
      if (sender.id === browser.runtime.id && typeof message === 'object' && message !== null && 'type' in message && message.type === 'vegsnap-store-disabled') cleanup();
    };
    browser.runtime.onMessage.addListener(disabled);
    document.addEventListener('change', rescan);
    window.addEventListener('popstate', rescan);
    ctx.addEventListener(window, 'wxt:locationchange', rescan);
    function cleanup() {
      if (!active) return;
      active = false; ctx.abort(); clearTimeout(timer); mutations.disconnect(); observer.disconnect();
      browser.runtime.onMessage.removeListener(disabled);
      document.removeEventListener('change', rescan);
      window.removeEventListener('popstate', rescan);
      for (const host of badges.keys()) host.remove(); badges.clear();
      if (shared.__vegsnapStoreCleanup === cleanup) delete shared.__vegsnapStoreCleanup;
    }
    shared.__vegsnapStoreCleanup = cleanup;
    ctx.onInvalidated(cleanup);
    scan();
  },
});
