import { defineConfig } from 'wxt';
import preact from '@preact/preset-vite';

export default defineConfig({
  vite: () => ({ plugins: [preact()] }),
  manifestVersion: 3,
  manifest: ({ browser }) => ({
    name: 'Vegsnap',
    description: 'Check products with evidence. Your history stays on this device.',
    icons: { 16: 'icons/16.png', 32: 'icons/32.png', 48: 'icons/48.png', 96: 'icons/96.png', 128: 'icons/128.png' },
    action: { default_icon: { 16: 'icons/16.png', 32: 'icons/32.png', 48: 'icons/48.png' } },
    permissions: ['storage', 'contextMenus', 'activeTab', 'scripting'],
    optional_permissions: ['nativeMessaging'],
    optional_host_permissions: ['https://*/*', 'http://localhost/*', 'http://127.0.0.1/*'],
    host_permissions: ['https://world.openfoodfacts.org/*', 'https://world.openbeautyfacts.org/*', 'https://world.openproductsfacts.org/*'],
    ...(browser === 'firefox' ? { browser_specific_settings: { gecko: { id: 'vegsnap@vegsnap.app', strict_min_version: '140.0', data_collection_permissions: { required: ['none'], optional: ['websiteContent', 'browsingActivity', 'authenticationInfo', 'personallyIdentifyingInfo'] } } } } : {}),
  }),
});
