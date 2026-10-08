import { browser } from 'wxt/browser';
import { HOSTED_AI } from '@vegsnap/core';
import { aiFetch, AI_DATA, requireDataConsent } from './data-consent';
import { endpointOrigin } from './settings';
import { isRecord } from './protocol';

export interface HostedStatus { state: 'signedout' | 'pending' | 'connected'; remaining?: number; expiresAt?: number; enabled?: boolean; }
export async function hostedToken(): Promise<string> {
  const value: unknown = (await browser.storage.session.get('hostedCredential')).hostedCredential;
  return isRecord(value) && value.endpoint === HOSTED_AI.baseUrl && typeof value.token === 'string' && /^[a-f0-9]{64}$/.test(value.token) ? value.token : '';
}
async function call(path: string, token: string, method = 'GET', body?: string) {
  await requireDataConsent(AI_DATA);
  if (!(await browser.permissions.contains({ origins: [endpointOrigin(HOSTED_AI.baseUrl)] }))) throw new Error('Allow access to Vegsnap AI first.');
  return aiFetch(`${HOSTED_AI.baseUrl}${path}`, { method, credentials: 'omit', redirect: 'error',
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body } : {}), signal: AbortSignal.timeout(15_000) });
}
let commands = Promise.resolve<HostedStatus>({ state: 'signedout' });
export function hostedCommand(command: 'connect' | 'status' | 'disconnect'): Promise<HostedStatus> {
  const next = commands.catch(() => ({ state: 'signedout' } as const)).then(() => run(command));
  commands = next;
  return next;
}
async function run(command: 'connect' | 'status' | 'disconnect'): Promise<HostedStatus> {
  let token = await hostedToken();
  if (command === 'disconnect') {
    await browser.storage.session.remove(['hostedCredential', 'hostedStatus']);
    if (token) { try { await call('/api/session', token, 'DELETE'); } catch { /* Local access is already removed; remote access expires. */ } }
    return { state: 'signedout' };
  }
  if (command === 'connect') {
    const randomId = () => Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, '0')).join('');
    const saved: unknown = (await browser.storage.local.get('hostedInstallationId')).hostedInstallationId;
    const installationId = typeof saved === 'string' && /^[a-f0-9]{64}$/.test(saved) ? saved : randomId();
    if (installationId !== saved) await browser.storage.local.set({ hostedInstallationId: installationId });
    token ||= randomId();
    const response = await call('/api/connect', token, 'POST', JSON.stringify({ installationId }));
    if (!response.ok) throw new Error(response.status === 503 ? 'Free AI checks are not available yet.' : 'The free connection allowance is unavailable. Try again later.');
    await browser.storage.session.set({ hostedCredential: { endpoint: HOSTED_AI.baseUrl, token }, hostedStatus: { state: 'pending' } });
  }
  if (!token) return { state: 'signedout' };
  const response = await call('/api/session', token);
  if (token !== await hostedToken()) return { state: 'signedout' };
  if (response.status === 401) {
    await browser.storage.session.remove(['hostedCredential', 'hostedStatus']);
    return { state: 'signedout' };
  }
  if (!response.ok) throw new Error('Could not refresh your free AI allowance.');
  const status: unknown = await response.json();
  if (!isRecord(status) || !['pending', 'connected'].includes(String(status.state)) || typeof status.remaining !== 'number' || typeof status.expiresAt !== 'number' || typeof status.enabled !== 'boolean') throw new Error('Invalid free AI session.');
  const result: HostedStatus = { state: status.state === 'connected' ? 'connected' : 'pending',
    remaining: status.remaining, expiresAt: status.expiresAt, enabled: status.enabled };
  await browser.storage.session.set({ hostedStatus: result });
  if (command === 'connect' && result.state === 'pending') await browser.tabs.create({ url: `${HOSTED_AI.baseUrl}/#token=${token}` });
  return result;
}
