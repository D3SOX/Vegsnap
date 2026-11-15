import { browser } from 'wxt/browser';
import { AIFailure } from '@vegsnap/core';

export const CONTENT_DATA = ['websiteContent', 'browsingActivity'] as const;
export const ACCOUNT_DATA = ['authenticationInfo', 'personallyIdentifyingInfo'] as const;
export const AI_DATA = [...CONTENT_DATA, 'authenticationInfo'] as const;
type DataType = typeof CONTENT_DATA[number] | typeof ACCOUNT_DATA[number];
type Permissions = Parameters<typeof browser.permissions.request>[0] & { data_collection?: DataType[] };

function dataPermissions(data: readonly DataType[]): Permissions {
  return browser.runtime.getURL('/').startsWith('moz-extension:') ? { data_collection: [...data] } : {};
}

// Call directly from the click handler so Firefox retains the user gesture.
export function requestDataConsent(data: readonly DataType[], permissions: Permissions = {}): Promise<boolean> {
  const requested = { ...permissions, ...dataPermissions(data) };
  return Object.keys(requested).length ? browser.permissions.request(requested) : Promise.resolve(true);
}

export async function hasDataConsent(data: readonly DataType[]): Promise<boolean> {
  const permissions = dataPermissions(data);
  return !permissions.data_collection || browser.permissions.contains(permissions);
}

export async function requireDataConsent(data: readonly DataType[]): Promise<void> {
  // Fixed copy with the only way to recover, so failed checks show it instead of a generic retry hint.
  const message = 'Allow data sharing for this feature in Firefox’s extension permissions, or use local checks.';
  if (!(await hasDataConsent(data))) throw new AIFailure('request_rejected', message, undefined, message);
}

// Check at the network boundary, including after consent is revoked.
export const contentFetch: typeof fetch = Object.assign(async (...args: Parameters<typeof fetch>) => {
  await requireDataConsent(CONTENT_DATA);
  return fetch(...args);
}, { preconnect: globalThis.fetch.preconnect });
export const aiFetch: typeof fetch = Object.assign(async (...args: Parameters<typeof fetch>) => {
  await requireDataConsent(AI_DATA);
  return fetch(...args);
}, { preconnect: globalThis.fetch.preconnect });
// Matspar's API only allows its own website as a CORS origin, so browsers block extension requests.
// Skip that catalogue without sending the search terms; other catalogue lookups use the AI boundary.
export const catalogueFetch: typeof fetch = Object.assign(async (...args: Parameters<typeof fetch>) => {
  const [input] = args;
  if ((input instanceof Request ? input.url : String(input)).startsWith('https://api.matspar.se/')) throw new Error('Matspar is not available in the extension.');
  return aiFetch(...args);
}, { preconnect: globalThis.fetch.preconnect });
