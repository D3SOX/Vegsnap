// Isolated process: exercise the real transport with Chromium's newly granted permission.
import { mock } from 'bun:test';
import { strict as assert } from 'node:assert';

let permissionGranted = true;
let reloads = 0;
const commands: string[] = [];
const runtime: {
  getURL(path: string): string;
  reload(): void;
  connectNative?: typeof nativePort;
} = {
  getURL: path => `chrome-extension://fixture${path}`,
  reload() { reloads++; },
};
function nativePort(host: string) {
  assert.equal(host, 'org.vegsnap.companion');
  let messageListener: (message: unknown) => void = () => {};
  let disconnectListener: () => void = () => {};
  return {
    onMessage: { addListener(listener: typeof messageListener) { messageListener = listener; } },
    onDisconnect: { addListener(listener: typeof disconnectListener) { disconnectListener = listener; } },
    disconnect() { disconnectListener(); },
    postMessage(request: { id: string; command: string }) {
      commands.push(request.command);
      queueMicrotask(() => messageListener({ id: request.id, ok: true, result: { connected: true } }));
    },
  };
}
mock.module('wxt/browser', () => ({ browser: {
  runtime,
  permissions: { async contains() { return permissionGranted; } },
} }));
const { companion } = await import('../src/companion');

// Chromium can grant nativeMessaging while the existing worker still lacks its API.
await assert.rejects(() => companion('signIn'), /reopen Vegsnap and connect ChatGPT again/i);
assert.equal(reloads, 1, 'A stale worker must reload to acquire the native messaging API');
assert.deepEqual(commands, [], 'No native request is attempted through a missing API');

// A fresh worker exposes the API and the same sign-in succeeds without another reload.
runtime.connectNative = nativePort;
assert.deepEqual(await companion('signIn'), { connected: true });
assert.deepEqual(await companion('status'), { connected: true });
assert.deepEqual(commands, ['signIn', 'status']);
assert.equal(reloads, 1);

delete runtime.connectNative;
permissionGranted = false;
await assert.rejects(() => companion('signIn'), /Enable the desktop companion/);
assert.equal(reloads, 1, 'Denied or revoked permissions must not trigger a reload');

permissionGranted = true;
const controller = new AbortController();
controller.abort();
await assert.rejects(() => companion('signIn', undefined, controller.signal), { name: 'AbortError' });
assert.equal(reloads, 1, 'Cancelled requests must not trigger a reload');
console.log('Native transport: missing API reloads the stale worker; fresh sign-in succeeds; denial and cancellation do not reload');
