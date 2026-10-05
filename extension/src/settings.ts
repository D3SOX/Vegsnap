// Explicit marketplace allowlist; never grant arbitrary *.amazon.* domains.
export const AMAZON_MARKETS: Readonly<Record<string, string>> = {
  'amazon.com': 'US', 'amazon.ca': 'CA', 'amazon.com.mx': 'MX', 'amazon.com.br': 'BR',
  'amazon.co.uk': 'GB', 'amazon.ie': 'IE', 'amazon.de': 'DE', 'amazon.fr': 'FR',
  'amazon.it': 'IT', 'amazon.es': 'ES', 'amazon.nl': 'NL', 'amazon.com.be': 'BE',
  'amazon.se': 'SE', 'amazon.pl': 'PL', 'amazon.com.tr': 'TR',
  'amazon.co.jp': 'JP', 'amazon.in': 'IN', 'amazon.com.au': 'AU', 'amazon.sg': 'SG',
  'amazon.com.sg': 'SG', 'amazon.ae': 'AE', 'amazon.sa': 'SA', 'amazon.eg': 'EG',
  'amazon.co.za': 'ZA', 'amazon.cn': 'CN',
};
export interface Store { id: string; name: string; origins: readonly string[]; }
export const STORES: readonly Store[] = [
  { id: 'amazon', name: 'Amazon', origins: Object.keys(AMAZON_MARKETS).map(domain => `https://*.${domain}/*`) },
  { id: 'dm', name: 'dm.de', origins: ['https://www.dm.de/*'] },
  { id: 'rewe', name: 'REWE', origins: ['https://www.rewe.de/*'] },
  { id: 'zalando', name: 'Zalando', origins: ['https://www.zalando.de/*'] },
];
export function storeMarket(url: string): string {
  const host = new URL(url).hostname;
  return Object.entries(AMAZON_MARKETS).find(([domain]) => host === domain || host.endsWith(`.${domain}`))?.[1] ?? 'DE';
}
export const PRESETS = {
  openai: 'https://api.openai.com/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  gemini: 'https://generativelanguage.googleapis.com/v1beta/openai',
  ollama: 'http://localhost:11434/v1',
  custom: '',
} as const;
export type Connection = 'chatgpt' | 'database' | keyof typeof PRESETS;
export interface Settings {
  language: 'en' | 'de';
  connection: Connection;
  baseUrl: string;
  model: string;
  stores: string[];
  saveHistory: boolean;
}
export const defaultSettings: Settings = { language: 'en', connection: 'chatgpt', baseUrl: PRESETS.openai, model: '', stores: [], saveHistory: true };
export function endpointOrigin(endpoint: string): string {
  const url = new URL(endpoint);
  if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)))) throw new Error('Use HTTPS, or HTTP on localhost, without credentials or query parameters.');
  // Firefox match patterns do not support ports. The request and credential stay
  // bound to the original full endpoint even though the host permission is wider.
  return `${url.protocol}//${url.hostname}/*`;
}
export function preferredLanguage(locale: string): Settings['language'] {
  return /^de(?:[-_]|$)/i.test(locale) ? 'de' : 'en';
}
export function parseSettings(value: unknown, locale = 'en'): Settings {
  if (!value || typeof value !== 'object') return { ...defaultSettings, language: preferredLanguage(locale) };
  const v = value as Record<string, unknown>;
  const connection = typeof v.connection === 'string' && ['chatgpt', 'database', ...Object.keys(PRESETS)].includes(v.connection) ? v.connection as Connection : defaultSettings.connection;
  return { language: v.language === 'en' || v.language === 'de' ? v.language : preferredLanguage(locale), connection, baseUrl: typeof v.baseUrl === 'string' ? v.baseUrl : PRESETS.openai, model: typeof v.model === 'string' ? v.model.slice(0, 200) : '', stores: Array.isArray(v.stores) ? v.stores.filter((s): s is string => typeof s === 'string' && STORES.some(store => store.id === s)) : [], saveHistory: v.saveHistory !== false };
}
