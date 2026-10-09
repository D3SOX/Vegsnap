import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const setup = readFileSync(new URL('../website/setup.js', import.meta.url), 'utf8');
const macUserAgent = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 26_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.2 Safari/605.1.15';

interface BrowserHints {
  userAgent: string;
  platform: string;
  maxTouchPoints?: number;
  userAgentData?: { platform: string; mobile: boolean };
}

function selectedOs(hints: BrowserHints) {
  const systems = ['linux', 'windows', 'macos'];
  const sections = ['install', 'register'].flatMap(group =>
    systems.map(os => ({ group, dataset: { os }, open: false })));
  const downloads = new Map(systems.map(os => [os, new Set<string>()]));
  const viewer = {
    open: false,
    querySelector: () => ({ addEventListener() {} }),
    addEventListener() {},
  };
  runInNewContext(setup, {
    navigator: { maxTouchPoints: 0, ...hints },
    document: {
      querySelectorAll: (selector: string) => selector === '.companion-setup details[data-os]' ? sections : [],
      querySelector: (selector: string) => selector === '.image-viewer' ? viewer
        : selector === '[data-browser-select]' ? null
        : { classList: { add: (name: string) => downloads.get(selector.match(/data-download-os="(\w+)"/)![1]!)!.add(name) } },
    },
    matchMedia: () => ({ matches: false, addEventListener() {} }),
  });
  return {
    install: sections.filter(section => section.group === 'install' && section.open).map(section => section.dataset.os),
    register: sections.filter(section => section.group === 'register' && section.open).map(section => section.dataset.os),
    downloads: [...downloads].filter(([, classes]) => classes.has('primary')).map(([os]) => os),
  };
}

test('selects macOS when Firefox on Linux spoofs a Safari macOS user agent', () => {
  expect(selectedOs({ userAgent: macUserAgent, platform: 'Linux x86_64' })).toEqual({
    install: ['macos'], register: ['macos'], downloads: ['macos'],
  });
});

interface BrowserIdentityHints extends BrowserHints {
  userAgentData?: { platform: string; mobile: boolean; brands?: { brand: string; version: string }[] };
  brave?: { isBrave: () => Promise<boolean> };
}

function detectedBrowser(hints: BrowserIdentityHints): Promise<string | null> {
  // Exercise the real detection code without mocking the picker DOM.
  const detection = setup.slice(0, setup.indexOf('// All commands remain available'));
  return runInNewContext(detection + '\ndetectDesktopBrowser(navigator);', {
    navigator: hints,
    document: { querySelectorAll: () => [], querySelector: () => null },
  });
}

describe('browser identity hints', () => {
  const cases: { name: string; hints: Partial<BrowserIdentityHints>; browser: string | null }[] = [
    ...[
      ['Brave', 'brave'], ['Helium', 'helium'], ['Vivaldi', 'vivaldi'], ['Microsoft Edge', 'edge'],
      ['LibreWolf', 'librewolf'], ['Zen Browser', 'zen'], ['Firefox', 'firefox'], ['Google Chrome', 'chrome'],
    ].map(([brand, browser]) => ({
      name: brand!,
      hints: { userAgentData: { platform: 'Linux', mobile: false, brands: [{ brand: 'Chromium', version: '140' }, { brand: brand!, version: '140' }] } },
      browser: browser!,
    })),
    ...[
      ['Brave', 'brave'], ['Helium', 'helium'], ['Vivaldi', 'vivaldi'], ['Edg', 'edge'],
      ['LibreWolf', 'librewolf'], ['Zen', 'zen'], ['Firefox', 'firefox'], ['Chromium', 'chromium'],
    ].map(([agent, browser]) => ({
      name: agent! + ' user agent',
      hints: { userAgent: 'Mozilla/5.0 Chrome/140.0 ' + agent + '/140.0' },
      browser: browser!,
    })),
    { name: 'Firefox fork takes priority', hints: { userAgent: 'Mozilla/5.0 Firefox/140.0 LibreWolf/140.0' }, browser: 'librewolf' },
    { name: 'Vivaldi takes priority over Chrome branding', hints: { userAgent: 'Vivaldi/7.0', userAgentData: { platform: 'Linux', mobile: false, brands: [{ brand: 'Google Chrome', version: '140' }] } }, browser: 'vivaldi' },
    { name: 'generic Chromium brands remain unselected', hints: { userAgent: 'Mozilla/5.0 Chrome/140.0', userAgentData: { platform: 'Linux', mobile: false, brands: [{ brand: 'Chromium', version: '140' }, { brand: 'Not A Brand', version: '99' }] } }, browser: null },
    { name: 'Safari is unsupported', hints: { userAgent: macUserAgent }, browser: null },
    { name: 'missing hints', hints: {}, browser: null },
  ];
  test.each(cases)('$name', async ({ hints, browser }) => {
    expect(await detectedBrowser({ userAgent: '', platform: '', ...hints })).toBe(browser);
  });
  test('Brave API takes priority over Chrome branding', async () => {
    expect(await detectedBrowser({
      userAgent: 'Mozilla/5.0 Chrome/140.0', platform: 'Linux',
      userAgentData: { platform: 'Linux', mobile: false, brands: [{ brand: 'Google Chrome', version: '140' }] },
      brave: { isBrave: async () => true },
    })).toBe('brave');
  });
  test('a blocked Brave API preserves the advertised identity', async () => {
    expect(await detectedBrowser({
      userAgent: 'Mozilla/5.0 Edg/140.0', platform: 'Linux',
      brave: { isBrave: async () => { throw new Error('Blocked'); } },
    })).toBe('edge');
  });
});

describe('desktop OS hints', () => {
  const cases: { name: string; hints: BrowserHints; os: string | null }[] = [
    { name: 'Safari on macOS', hints: { userAgent: macUserAgent, platform: 'MacIntel' }, os: 'macos' },
    { name: 'Firefox on Windows', hints: { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:144.0) Gecko/20100101 Firefox/144.0', platform: 'Win32' }, os: 'windows' },
    { name: 'Firefox on Linux', hints: { userAgent: 'Mozilla/5.0 (X11; Linux x86_64; rv:144.0) Gecko/20100101 Firefox/144.0', platform: 'Linux x86_64' }, os: 'linux' },
    { name: 'spoofed Windows on Linux', hints: { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', platform: 'Linux x86_64' }, os: 'windows' },
    { name: 'spoofed Linux on Windows', hints: { userAgent: 'Mozilla/5.0 (X11; Linux x86_64)', platform: 'Win32' }, os: 'linux' },
    { name: 'user agent overrides client hints', hints: { userAgent: macUserAgent, platform: 'Linux x86_64', userAgentData: { platform: 'Linux', mobile: false } }, os: 'macos' },
    { name: 'client hints fallback', hints: { userAgent: '', platform: 'Linux x86_64', userAgentData: { platform: 'Windows', mobile: false } }, os: 'windows' },
    { name: 'legacy macOS fallback', hints: { userAgent: '', platform: 'MacIntel' }, os: 'macos' },
    { name: 'legacy Windows fallback', hints: { userAgent: '', platform: 'Win32' }, os: 'windows' },
    { name: 'legacy Linux fallback', hints: { userAgent: '', platform: 'Linux x86_64' }, os: 'linux' },
    { name: 'unrecognized client hints fall back to legacy platform', hints: { userAgent: 'unknown', platform: 'MacIntel', userAgentData: { platform: 'Unknown', mobile: false } }, os: 'macos' },
    { name: 'unknown OS', hints: { userAgent: 'unknown', platform: 'unknown' }, os: null },
    { name: 'missing OS hints', hints: { userAgent: '', platform: '' }, os: null },
    { name: 'Darwin is not Windows', hints: { userAgent: '', platform: 'Darwin' }, os: null },
    { name: 'Android is not desktop Linux', hints: { userAgent: 'Mozilla/5.0 (Linux; Android 16; Pixel 9) AppleWebKit/537.36 Chrome/144.0.0.0 Mobile Safari/537.36', platform: 'Linux aarch64' }, os: null },
    { name: 'iPhone is not macOS', hints: { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148', platform: 'iPhone' }, os: null },
    { name: 'iPad desktop user agent is not macOS', hints: { userAgent: macUserAgent, platform: 'MacIntel', maxTouchPoints: 5 }, os: null },
    { name: 'Windows touchscreens remain Windows', hints: { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', platform: 'Win32', maxTouchPoints: 10 }, os: 'windows' },
    { name: 'spoofing macOS on touchscreen Linux', hints: { userAgent: macUserAgent, platform: 'Linux x86_64', maxTouchPoints: 10 }, os: 'macos' },
    { name: 'ChromeOS is not desktop Linux', hints: { userAgent: 'Mozilla/5.0 (X11; CrOS x86_64 16093.0.0) AppleWebKit/537.36 Chrome/144.0.0.0 Safari/537.36', platform: 'Linux x86_64' }, os: null },
    { name: 'mobile client hint', hints: { userAgent: 'unknown', platform: 'Linux aarch64', userAgentData: { platform: 'Android', mobile: true } }, os: null },
    { name: 'Android tablet client hint', hints: { userAgent: 'unknown', platform: 'Linux aarch64', userAgentData: { platform: 'Android', mobile: false } }, os: null },
    { name: 'ChromeOS client hint', hints: { userAgent: 'unknown', platform: 'Linux x86_64', userAgentData: { platform: 'Chrome OS', mobile: false } }, os: null },
  ];

  test.each(cases)('$name', ({ hints, os }) => {
    const selected = os ? [os] : [];
    expect(selectedOs(hints)).toEqual({ install: selected, register: selected, downloads: selected });
  });
});
