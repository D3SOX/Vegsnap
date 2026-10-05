// Isolated browser transport with the real provider adapter and product evaluation pipeline.
import { mock } from 'bun:test';
import { strict as assert } from 'node:assert';
import { checkProduct } from '@veguide/core';

let failure = '';
const commands: string[] = [];
mock.module('wxt/browser', () => ({ browser: {
  permissions: { async contains() { return true; } },
  runtime: { connectNative() {
    let listener: (message: unknown) => void = () => {};
    let disconnect: () => void = () => {};
    return {
      onMessage: { addListener(value: typeof listener) { listener = value; } },
      onDisconnect: { addListener(value: typeof disconnect) { disconnect = value; } },
      disconnect() { disconnect(); },
      postMessage(request: { id: string; command: string }) {
        commands.push(request.command);
        queueMicrotask(() => listener(request.command === 'check'
          ? { id: request.id, ok: false, error: failure }
          : { id: request.id, ok: true, result: { connected: true } }));
      },
    };
  } },
} }));
const { companion, companionProvider } = await import('../src/companion');
for (const message of [
  'ChatGPT usage for this app has reached its limit. Check ChatGPT Settings → Usage, then retry when usage is available.',
  'ChatGPT could not check usage availability. Your connection is still saved; try again later.',
]) {
  failure = message;
  const before = commands.length;
  const result = await checkProduct({ text: 'unidentified additive', category: 'food', complete: true },
    { mode: 'explicit', provider: companionProvider('fixture-model') });
  assert.equal(result.aiStatus, 'failed');
  assert.equal(result.outcome, 'uncertain');
  assert.equal(result.usedAI, false);
  assert(result.warnings.includes(message), 'The specific companion recovery message must survive into the visible result');
  assert.deepEqual(commands.slice(before), ['check'], 'A rejected plan check must not silently retry or invoke OAuth');
  assert.deepEqual(await companion('status'), { connected: true }, 'Plan usage errors do not disconnect the saved account');
}
console.log('Companion plan errors: actionable usage/service messages survive native transport and evaluation without retries or account loss');
