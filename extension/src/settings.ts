import { countryCode } from '@vegsnap/core';
import HOSTED_AI from '../../data/hosted-ai.json';

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
export type Connection = 'chatgpt' | 'database' | 'hosted' | keyof typeof PRESETS;
export interface Settings {
  language: 'en' | 'de';
  connection: Connection;
  baseUrl: string;
  model: string;
  stores: string[];
  saveHistory: boolean;
  autoCountry: boolean;
  fallbackCountry: string;
  api?: { connection: keyof typeof PRESETS; baseUrl: string; model: string };
  chatgptModel?: string;
}
export const defaultSettings: Settings = { language: 'en', connection: 'hosted', baseUrl: HOSTED_AI.baseUrl, model: HOSTED_AI.model, stores: [], saveHistory: true, autoCountry: true, fallbackCountry: 'DE' };
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
export function changeConnectionSettings(current: Settings, connection: Connection): Settings {
  const chatgptModel = current.connection === 'chatgpt' ? current.model : current.chatgptModel;
  const api = current.connection in PRESETS
    ? { connection: current.connection as keyof typeof PRESETS, baseUrl: current.baseUrl, model: current.model } : current.api;
  if (connection in PRESETS) {
    const selected = api?.connection === connection ? api : { connection: connection as keyof typeof PRESETS, baseUrl: PRESETS[connection as keyof typeof PRESETS], model: '' };
    return { ...current, ...selected, api: selected, chatgptModel };
  }
  return { ...current, connection, api, chatgptModel, ...(connection === 'chatgpt' ? { model: chatgptModel ?? '' } : {}) };
}
export function parseSettings(value: unknown, locale = 'en'): Settings {
  if (!value || typeof value !== 'object') return { ...defaultSettings, language: preferredLanguage(locale) };
  const v = value as Record<string, unknown>;
  const connection = typeof v.connection === 'string' && ['chatgpt', 'database', 'hosted', ...Object.keys(PRESETS)].includes(v.connection) ? v.connection as Connection : defaultSettings.connection;
  const settings: Settings = { language: v.language === 'en' || v.language === 'de' ? v.language : preferredLanguage(locale), connection, baseUrl: typeof v.baseUrl === 'string' ? v.baseUrl : connection === 'hosted' ? HOSTED_AI.baseUrl : PRESETS.openai, model: typeof v.model === 'string' ? v.model.slice(0, 200) : connection === 'hosted' ? HOSTED_AI.model : '', stores: Array.isArray(v.stores) ? v.stores.filter((s): s is string => typeof s === 'string' && STORES.some(store => store.id === s)) : [], saveHistory: v.saveHistory !== false, autoCountry: v.autoCountry !== false, fallbackCountry: typeof v.fallbackCountry === 'string' ? countryCode(v.fallbackCountry) ?? 'DE' : 'DE' };
  const api = v.api;
  if (connection === 'chatgpt') settings.chatgptModel = settings.model;
  else if (typeof v.chatgptModel === 'string') settings.chatgptModel = v.chatgptModel.slice(0, 200);
  if (connection in PRESETS) settings.api = { connection: connection as keyof typeof PRESETS, baseUrl: settings.baseUrl, model: settings.model };
  else if (api && typeof api === 'object' && !Array.isArray(api)) {
    const saved = api as Record<string, unknown>;
    if (typeof saved.connection === 'string' && Object.hasOwn(PRESETS, saved.connection) && typeof saved.baseUrl === 'string' && typeof saved.model === 'string') {
      settings.api = { connection: saved.connection as keyof typeof PRESETS, baseUrl: saved.baseUrl.slice(0, 2000), model: saved.model.slice(0, 200) };
    }
  }
  return settings;
}
