import { countryCode, createOpenAIProvider, HOSTED_AI, type CheckInput, type ProviderAdapter } from '@vegsnap/core';
import { readBoundedText } from '../../core/src/http';

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  REQUEST_LIMIT: RateLimit;
  SESSION_REQUEST_LIMIT: RateLimit;
  PUBLIC_ORIGIN: string;
  TURNSTILE_SITE_KEY: string;
  TURNSTILE_SECRET?: string;
  OPENAI_API_KEY?: string;
  AI_ENABLED: string;
  DAILY_CHECK_LIMIT: string;
  SESSION_CHECK_LIMIT: string;
  DAILY_CONNECT_LIMIT: string;
  PENDING_CONNECT_LIMIT: string;
}
class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
const day = () => new Date().toISOString().slice(0, 10);
const now = () => Math.floor(Date.now() / 1000);
const enabled = (env: Env) => env.AI_ENABLED === 'true' && !!env.OPENAI_API_KEY && !!env.TURNSTILE_SECRET && !!env.TURNSTILE_SITE_KEY;
function limit(value: string): number {
  if (!/^[1-9]\d{0,5}$/.test(value)) throw new HttpError(503, 'Free allowance is not configured.');
  return Number(value);
}
const json = (body: unknown, status = 200) => Response.json(body, { status });
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
async function body(request: Request, maximum: number): Promise<unknown> {
  if (request.headers.get('Content-Type')?.split(';')[0] !== 'application/json') throw new HttpError(415, 'Send JSON.');
  if (Number(request.headers.get('Content-Length') ?? 0) > maximum) throw new HttpError(413, 'Request is too large.');
  try { return JSON.parse(await readBoundedText(new Response(request.body), maximum)); }
  catch { throw new HttpError(400, 'Invalid or oversized JSON.'); }
}
async function hashToken(request: Request): Promise<string> {
  const token = request.headers.get('Authorization')?.replace(/^Bearer /, '') ?? '';
  if (!/^[a-f0-9]{64}$/.test(token)) throw new HttpError(401, 'Connect to Vegsnap AI in settings.');
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))), byte => byte.toString(16).padStart(2, '0')).join('');
}
function product(value: unknown): { input: CheckInput; countryContext: Parameters<ProviderAdapter['extract']>[2] } {
  const fields = ['text', 'name', 'brand', 'barcode', 'sourceUrl', 'market', 'locale', 'category', 'complete', 'images', 'countryContext'];
  if (!record(value) || Object.keys(value).some(key => !fields.includes(key))) throw new HttpError(400, 'Invalid product input.');
  for (const [key, maximum] of [['text', 30_000], ['name', 300], ['brand', 300], ['barcode', 30], ['sourceUrl', 2000], ['market', 2]] as const) {
    if (value[key] !== undefined && (typeof value[key] !== 'string' || value[key].length > maximum)) throw new HttpError(400, `Invalid ${key}.`);
  }
  if (value.locale !== undefined && !['en', 'de'].includes(String(value.locale)) ||
      value.category !== undefined && !['food', 'drink', 'cosmetics', 'household', 'clothing', 'shoes', 'other'].includes(String(value.category)) ||
      value.complete !== undefined && typeof value.complete !== 'boolean') throw new HttpError(400, 'Invalid product context.');
  if (value.images !== undefined && (!Array.isArray(value.images) || value.images.length > 3 || value.images.some(image =>
      typeof image !== 'string' || image.length > 4_000_000 || !/^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+=*$/.test(image)))) throw new HttpError(400, 'Invalid product photos.');
  if (!value.text && !value.name && !(Array.isArray(value.images) && value.images.length)) throw new HttpError(400, 'Add product text or a photo.');
  const { countryContext, ...input } = value;
  if (countryContext !== undefined && (!record(countryContext) ||
      Object.keys(countryContext).some(key => !['fallbackMarket', 'markets'].includes(key)) ||
      typeof countryContext.fallbackMarket !== 'string' || countryCode(countryContext.fallbackMarket) !== countryContext.fallbackMarket ||
      !Array.isArray(countryContext.markets) || countryContext.markets.length > 250 ||
      countryContext.markets.some(tag => typeof tag !== 'string' || tag !== 'unknown' && countryCode(tag) !== tag))) {
    throw new HttpError(400, 'Invalid product country context.');
  }
  return { input: { ...input, ...(countryContext ? { autoMarket: true } : {}) } as CheckInput,
    countryContext: countryContext as Parameters<ProviderAdapter['extract']>[2] };
}
async function route(request: Request, env: Env): Promise<Response> {
  const path = new URL(request.url).pathname;
  const today = day();
  if (request.method === 'OPTIONS' && path.startsWith('/api/')) return new Response(null, { status: 204 });
  if (request.method === 'GET' && path === '/api/config') return json({ enabled: enabled(env), model: HOSTED_AI.model,
    siteKey: env.TURNSTILE_SITE_KEY, sessionCheckLimit: limit(env.SESSION_CHECK_LIMIT), sessionHours: 24 });
  if (!path.startsWith('/api/')) {
    if (!['GET', 'HEAD'].includes(request.method) || !['/', '/connect.js', '/style.css'].includes(path)) throw new HttpError(404, 'Not found.');
    return env.ASSETS.fetch(request);
  }
  const tokenHash = await hashToken(request);
  if (path === '/api/session' && ['GET', 'DELETE'].includes(request.method) &&
      !(await env.SESSION_REQUEST_LIMIT.limit({ key: `${request.method}:${request.headers.get('CF-Connecting-IP') ?? 'unknown'}` })).success) throw new HttpError(429, 'Please wait before trying again.');
  if (path === '/api/session' && request.method === 'GET') {
    const session = await env.DB.prepare('SELECT verified, expires_at, day, checks, COALESCE((SELECT checks FROM installation_usage WHERE installation_hash = sessions.installation_hash AND day = ?), 0) AS installation_checks, COALESCE((SELECT checks FROM daily_budget WHERE day = ?), 0) AS global_checks FROM sessions WHERE token_hash = ? AND expires_at > ?').bind(today, today, tokenHash, now()).first<{verified: number; expires_at: number; day: string; checks: number; installation_checks: number; global_checks: number}>();
    if (!session) throw new HttpError(401, 'Your free session expired. Connect again in settings.');
    return json({ state: session.verified ? 'connected' : 'pending', expiresAt: session.expires_at * 1000,
      remaining: Math.max(0, Math.min(limit(env.SESSION_CHECK_LIMIT) - Math.max(session.day === today ? session.checks : 0, session.installation_checks),
        limit(env.DAILY_CHECK_LIMIT) - session.global_checks)), enabled: enabled(env) });
  }
  if (path === '/api/session' && request.method === 'DELETE') {
    await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(tokenHash).run();
    return json({ disconnected: true });
  }
  if (request.method !== 'POST' || !['/api/connect', '/api/verify', '/api/check'].includes(path)) throw new HttpError(404, 'Not found.');
  if (!enabled(env)) throw new HttpError(503, 'Vegsnap AI is not available yet. Use ChatGPT, your own API key, or database checks.');
  if (!(await env.REQUEST_LIMIT.limit({ key: `${path}:${request.headers.get('CF-Connecting-IP') ?? 'unknown'}` })).success) throw new HttpError(429, 'Please wait before trying again.');
  if (path === '/api/connect') {
    const value = await body(request, 4096);
    if (!record(value) || Object.keys(value).some(key => key !== 'installationId') || typeof value.installationId !== 'string' || !/^[a-f0-9]{64}$/.test(value.installationId)) throw new HttpError(400, 'Start the connection in Vegsnap.');
    const installationHash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value.installationId))), byte => byte.toString(16).padStart(2, '0')).join('');
    const existing = await env.DB.prepare('SELECT installation_hash, expires_at, day, checks FROM sessions WHERE token_hash = ?').bind(tokenHash)
      .first<{ installation_hash: string; expires_at: number; day: string; checks: number }>();
    if (existing && existing.installation_hash !== installationHash) throw new HttpError(403, 'This connection belongs to another installation.');
    if (existing && existing.expires_at > now()) {
      return json({ expiresIn: existing.expires_at - now() });
    }
    await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ? AND expires_at <= ?').bind(tokenHash, now()).run();
    const results = await env.DB.batch([
      env.DB.prepare('INSERT INTO sessions(token_hash, expires_at, day, installation_hash) SELECT ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM sessions WHERE token_hash = ?) AND (SELECT COUNT(*) FROM sessions WHERE verified = 0 AND expires_at > ?) < ?').bind(tokenHash, now() + 600, today, installationHash, tokenHash, now(), limit(env.PENDING_CONNECT_LIMIT)),
      env.DB.prepare('INSERT INTO installation_usage(installation_hash, day) SELECT ?, ? WHERE changes() = 1 ON CONFLICT DO NOTHING').bind(installationHash, today),
    ]);
    if (!results[0]?.meta.changes) throw new HttpError(429, 'Too many connections are waiting for verification. Try again shortly.');
    return json({ expiresIn: 600 }, 201);
  }
  if (path === '/api/verify') {
    if (request.headers.get('Origin') !== env.PUBLIC_ORIGIN) throw new HttpError(403, 'Verify on the Vegsnap page.');
    const value = await body(request, 4096);
    if (!record(value) || typeof value.challenge !== 'string' || value.challenge.length > 2048) throw new HttpError(400, 'Complete verification.');
    const pending = await env.DB.prepare('SELECT 1 FROM sessions WHERE token_hash = ? AND verified = 0 AND expires_at > ?').bind(tokenHash, now()).first();
    if (!pending) throw new HttpError(401, 'This connection expired. Start again in Vegsnap.');
    let verification: Response;
    let result: unknown;
    try {
      verification = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, redirect: 'manual', signal: AbortSignal.timeout(10_000),
        body: JSON.stringify({ secret: env.TURNSTILE_SECRET, response: value.challenge }),
      });
      result = await verification.json();
    } catch { throw new HttpError(502, 'Verification could not be checked. Please verify again.'); }
    if (!verification.ok || !record(result) || result.success !== true || result.hostname !== new URL(env.PUBLIC_ORIGIN).hostname || result.action !== 'connect-ai') throw new HttpError(403, 'Verification failed. Try again.');
    const verified = await env.DB.batch([
      env.DB.prepare('INSERT INTO daily_budget(day) VALUES (?) ON CONFLICT DO NOTHING').bind(today),
      env.DB.prepare('UPDATE daily_budget SET connections = connections + 1 WHERE day = ? AND connections < ? AND EXISTS (SELECT 1 FROM sessions WHERE token_hash = ? AND verified = 0 AND expires_at > ?)').bind(today, limit(env.DAILY_CONNECT_LIMIT), tokenHash, now()),
      env.DB.prepare('UPDATE sessions SET verified = 1, expires_at = ? WHERE token_hash = ? AND verified = 0 AND expires_at > ? AND changes() = 1').bind(now() + 86400, tokenHash, now()),
    ]);
    if (!verified[2]?.meta.changes) {
      const waiting = await env.DB.prepare('SELECT 1 FROM sessions WHERE token_hash = ? AND verified = 0 AND expires_at > ?').bind(tokenHash, now()).first();
      throw new HttpError(waiting ? 429 : 401, waiting ? 'The free connection allowance is full. Try again tomorrow.' : 'This connection expired or was already verified.');
    }
    return json({ connected: true });
  }
  if (!await env.DB.prepare('SELECT 1 FROM sessions WHERE token_hash = ? AND verified = 1 AND expires_at > ?').bind(tokenHash, now()).first()) throw new HttpError(401, 'Connect to Vegsnap AI in settings.');
  const { input, countryContext } = product(await body(request, 12_100_000));
  const results = await env.DB.batch([
    env.DB.prepare('INSERT INTO installation_usage(installation_hash, day) SELECT installation_hash, ? FROM sessions WHERE token_hash = ? ON CONFLICT DO NOTHING').bind(today, tokenHash),
    env.DB.prepare('INSERT INTO daily_budget(day) VALUES (?) ON CONFLICT DO NOTHING').bind(today),
    env.DB.prepare(`UPDATE daily_budget SET checks = checks + 1 WHERE day = ? AND checks < ?
      AND EXISTS (SELECT 1 FROM sessions WHERE token_hash = ? AND verified = 1 AND expires_at > ? AND (day != ? OR checks < ?)
        AND EXISTS (SELECT 1 FROM installation_usage WHERE installation_hash = sessions.installation_hash AND day = ? AND checks < ?))`)
      .bind(today, limit(env.DAILY_CHECK_LIMIT), tokenHash, now(), today, limit(env.SESSION_CHECK_LIMIT), today, limit(env.SESSION_CHECK_LIMIT)),
    env.DB.prepare('UPDATE sessions SET checks = CASE WHEN day = ? THEN checks + 1 ELSE 1 END, day = ? WHERE token_hash = ? AND changes() = 1').bind(today, today, tokenHash),
    env.DB.prepare('UPDATE installation_usage SET checks = checks + 1 WHERE day = ? AND installation_hash = (SELECT installation_hash FROM sessions WHERE token_hash = ?) AND changes() = 1').bind(today, tokenHash),
  ]);
  if (!results[3]?.meta.changes) {
    const session = await env.DB.prepare('SELECT 1 FROM sessions WHERE token_hash = ? AND verified = 1 AND expires_at > ?').bind(tokenHash, now()).first();
    throw new HttpError(session ? 429 : 401, session ? 'The free allowance is used up. Try again tomorrow.' : 'Connect to Vegsnap AI in settings.');
  }
  // The core adapter owns prompts, validation, and search provenance. Clients supply only product data.
  // No tools in the first pass; at most three search tool calls in the research pass.
  let calls = 0;
  const boundedFetch: typeof fetch = async (url, init) => {
    if (++calls > 2 || String(url) !== 'https://api.openai.com/v1/responses') throw new Error('Unexpected AI request.');
    const payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
    payload.model = HOSTED_AI.model;
    payload.reasoning = { effort: 'medium' };
    payload.max_output_tokens = 6000;
    payload.store = false;
    if (payload.tool_choice === 'required') {
      payload.tools = [{ type: 'web_search', search_context_size: 'low' }];
      payload.max_tool_calls = 3;
    } else {
      for (const key of ['tools', 'max_tool_calls', 'include']) delete payload[key];
    }
    return fetch(url, { ...init, body: JSON.stringify(payload), redirect: 'manual' });
  };
  try {
    // Public catalogue requests carry no AI credentials and do not consume the two-call AI budget.
    return json(await createOpenAIProvider({ baseUrl: 'https://api.openai.com/v1', model: HOSTED_AI.model, token: env.OPENAI_API_KEY, supportsVision: true }, boundedFetch, (url, init) => fetch(url, { ...init, redirect: 'manual' })).extract(input, request.signal, countryContext));
  } catch { throw new HttpError(502, 'AI could not complete this check. Its allowance was consumed; local evidence is still available.'); }
}
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    let response: Response;
    try { response = await route(request, env); }
    catch (error) { response = json({ error: { message: error instanceof HttpError ? error.message : 'Service unavailable.' } }, error instanceof HttpError ? error.status : 503); }
    const headers = new Headers(response.headers);
    headers.set('Cache-Control', 'no-store');
    headers.set('Referrer-Policy', 'no-referrer');
    headers.set('X-Content-Type-Options', 'nosniff');
    headers.set('Content-Security-Policy', "default-src 'self'; script-src 'self' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; connect-src 'self' https://challenges.cloudflare.com; style-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
    if (new URL(request.url).pathname.startsWith('/api/') && new URL(request.url).pathname !== '/api/verify') {
      headers.set('Access-Control-Allow-Origin', '*');
      headers.set('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
      headers.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    }
    if (response.status === 429) headers.set('Retry-After', '60');
    return new Response(response.body, { status: response.status, headers });
  },
  async scheduled(_event: ScheduledController, env: Env) {
    await env.DB.batch([env.DB.prepare('DELETE FROM sessions WHERE expires_at <= ?').bind(now()),
      env.DB.prepare('DELETE FROM daily_budget WHERE day < ?').bind(day()),
      env.DB.prepare('DELETE FROM installation_usage WHERE day < ?').bind(day())]);
  },
};
