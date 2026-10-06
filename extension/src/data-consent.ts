import { browser } from 'wxt/browser';

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
  if (!(await hasDataConsent(data))) throw new Error('Allow data sharing for this feature in Firefox’s extension permissions, or use local checks.');
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
