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
