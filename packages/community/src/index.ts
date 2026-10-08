import { communityIdentityKey, SubmissionError, validateCommunitySubmission, type CommunityReply, type CommunitySubmission } from '@vegsnap/core/community';
import { normalizeBarcode } from '@vegsnap/core/barcode';
import { cleanEvidence, MAX_EVIDENCE_BYTES } from './evidence';
import { ReportError, submitReport, reviewReports } from './reports';

export interface Env {
  DB: D1Database;
  EVIDENCE: R2Bucket;
  ASSETS: Fetcher;
  SUBMISSION_LIMIT: RateLimit;
  PUBLIC_ORIGIN: string;
  TURNSTILE_SITE_KEY: string;
  TURNSTILE_SECRET?: string;
  ADMIN_TOKEN?: string;
  SUBMISSIONS_ENABLED: string;
}
interface Row {
  id: string; product_name: string; brand: string; barcode: string; market: string; variant: string;
  question: string; reply: string; replied_on: string; claim: CommunitySubmission['claim']; scope: CommunitySubmission['scope'];
  source_url: string; evidence_key: string; evidence_type: string; evidence_public: number;
  status: 'pending' | 'approved' | 'rejected'; created_at: string; reviewed_at: string | null;
  review_note: string; original_json: string; revision: number;
}
class HttpError extends Error { constructor(public status: number, message: string) { super(message); } }
const json = (value: unknown, status = 200) => Response.json(value, { status });
const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
// Text limits count characters; allow their UTF-8 expansion plus multipart framing.
const MAX_METADATA_BYTES = 96_000;
function publicReply(row: Row): CommunityReply {
  return { id: row.id, productName: row.product_name, brand: row.brand, barcode: row.barcode, market: row.market,
    variant: row.variant, question: row.question, reply: row.reply, repliedOn: row.replied_on, claim: row.claim,
    scope: row.scope, sourceUrl: row.source_url, reviewedAt: row.reviewed_at!, evidencePublic: row.evidence_public === 1 };
}
async function boundedBody(request: Request, maxBytes: number): Promise<Uint8Array> {
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, 'The request body is missing.');
  const chunks: Uint8Array[] = []; let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      total += value.byteLength;
      if (total > maxBytes) { await reader.cancel(); throw new HttpError(413, 'The submission is too large. Evidence must be no larger than 2 MB.'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const body = new Uint8Array(total); let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.length; }
  return body;
}
async function parseJson(request: Request): Promise<Record<string, unknown>> {
  if (!request.headers.get('Content-Type')?.startsWith('application/json')) throw new HttpError(415, 'Use a JSON request.');
  let value: unknown;
  try { value = JSON.parse(new TextDecoder().decode(await boundedBody(request, MAX_METADATA_BYTES))); }
  catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(400, 'Invalid JSON.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'Invalid JSON.');
  return value as Record<string, unknown>;
}
async function isAdmin(request: Request, env: Env): Promise<boolean> {
  if (!env.ADMIN_TOKEN || env.ADMIN_TOKEN.length < 32) throw new HttpError(503, 'Review access is not configured.');
  const actual = request.headers.get('Authorization') ?? '';
  const digest = (value: string) => crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  const [a, b] = await Promise.all([digest(actual), digest(`Bearer ${env.ADMIN_TOKEN}`)]);
  const first = new Uint8Array(a), second = new Uint8Array(b); let diff = 0;
  for (let i = 0; i < first.length; i++) diff |= first[i]! ^ second[i]!;
  return diff === 0;
}
async function verifyChallenge(token: string, env: Env): Promise<void> {
  if (!env.TURNSTILE_SECRET || !env.PUBLIC_ORIGIN) throw new HttpError(503, 'Submissions are not configured yet.');
  if (!token || token.length > 2048) throw new SubmissionError('challenge', 'Complete the human verification.');
  let response: Response;
  try {
    response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(10_000),
      body: JSON.stringify({ secret: env.TURNSTILE_SECRET, response: token }),
    });
  } catch { throw new HttpError(503, 'Human verification is temporarily unavailable. Try again.'); }
  if (!response.ok) throw new HttpError(503, 'Human verification is temporarily unavailable. Try again.');
  const value: unknown = await response.json();
  if (!value || typeof value !== 'object' || !('success' in value) || value.success !== true ||
      !('hostname' in value) || value.hostname !== new URL(env.PUBLIC_ORIGIN).hostname ||
      !('action' in value) || value.action !== 'submit-reply') throw new SubmissionError('challenge', 'Human verification expired or failed. Try again.');
}
async function submit(request: Request, env: Env): Promise<Response> {
  if (env.SUBMISSIONS_ENABLED !== 'true') throw new HttpError(503, 'Submissions are not open yet.');
  if (request.headers.get('Origin') !== env.PUBLIC_ORIGIN) throw new HttpError(403, 'Submit using the Vegsnap form.');
  const { success } = await env.SUBMISSION_LIMIT.limit({ key: `submit:${request.headers.get('CF-Connecting-IP') ?? 'unknown'}` });
  if (!success) throw new HttpError(429, 'Too many submissions. Try again in a minute.');
  const contentType = request.headers.get('Content-Type') ?? '';
  if (!contentType.startsWith('multipart/form-data;')) throw new HttpError(415, 'Use the submission form.');
  const bytes = await boundedBody(request, MAX_EVIDENCE_BYTES + MAX_METADATA_BYTES);
  let form: FormData;
  try { form = await new Request(request.url, { method: 'POST', headers: { 'Content-Type': contentType }, body: bytes }).formData(); }
  catch { throw new HttpError(400, 'Invalid form data.'); }
  const raw: Record<string, unknown> = {};
  for (const key of ['productName', 'brand', 'barcode', 'market', 'variant', 'question', 'reply', 'repliedOn', 'claim', 'scope', 'sourceUrl']) raw[key] = form.get(key) ?? '';
  const submission = validateCommunitySubmission(raw);
  if (form.get('consent') !== 'yes') throw new SubmissionError('consent', 'Confirm that you have removed personal information and may share this response.');
  if (form.get('terms') !== 'yes') throw new SubmissionError('terms', 'Accept the contribution rules before sharing a reply.');
  const file = form.get('evidence');
  if (!(file instanceof File) || file.size === 0) throw new SubmissionError('evidence', 'Attach a redacted screenshot or PDF of the response.');
  if (file.size > MAX_EVIDENCE_BYTES) throw new SubmissionError('evidence', 'Evidence must be no larger than 2 MB.');
  await verifyChallenge(String(form.get('cf-turnstile-response') ?? ''), env);
  const evidence = cleanEvidence(new Uint8Array(await file.arrayBuffer()), file.type);
  const now = new Date().toISOString();
  const budget = await env.DB.prepare('INSERT INTO submission_budget(day, count) VALUES (?, 1) ON CONFLICT(day) DO UPDATE SET count = count + 1 WHERE count < 100 RETURNING count').bind(now.slice(0, 10)).first();
  if (!budget) throw new HttpError(429, 'The daily submission limit has been reached. Please try tomorrow.');
  const id = crypto.randomUUID(); const key = `replies/${id}`;
  await env.EVIDENCE.put(key, evidence.bytes, { httpMetadata: { contentType: evidence.type } });
  try {
    await env.DB.prepare(`INSERT INTO submissions(id, product_name, name_key, brand, brand_key, barcode, market, variant,
      question, reply, replied_on, claim, scope, source_url, evidence_key, evidence_type, created_at, original_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(id, submission.productName,
      communityIdentityKey(submission.productName), submission.brand, communityIdentityKey(submission.brand), submission.barcode,
      submission.market, submission.variant, submission.question, submission.reply, submission.repliedOn, submission.claim,
      submission.scope, submission.sourceUrl, key, evidence.type, now, JSON.stringify(submission)).run();
  } catch (error) { await env.EVIDENCE.delete(key); throw error; }
  return json({ id, status: 'pending' }, 201);
}
async function lookup(url: URL, env: Env): Promise<Response> {
  const market = url.searchParams.get('market')?.toUpperCase() ?? '';
  if (!/^[A-Z]{2}$/.test(market)) throw new SubmissionError('market', 'Select the product market.');
  const rawBarcode = url.searchParams.get('barcode') ?? '';
  let query: D1PreparedStatement;
  if (rawBarcode) {
    const barcode = normalizeBarcode(rawBarcode)?.padStart(14, '0');
    if (!barcode) throw new SubmissionError('barcode', 'Check the barcode digits and checksum.');
    query = env.DB.prepare("SELECT * FROM submissions WHERE status = 'approved' AND barcode = ? AND market = ? ORDER BY replied_on DESC, id LIMIT 51").bind(barcode, market);
  } else {
    const name = url.searchParams.get('name') ?? '', brand = url.searchParams.get('brand') ?? '';
    if (!name.trim() || !brand.trim() || name.length > 300 || brand.length > 300) throw new SubmissionError('name', 'Enter the exact product name and brand, or its barcode.');
    query = env.DB.prepare("SELECT * FROM submissions WHERE status = 'approved' AND name_key = ? AND brand_key = ? AND market = ? ORDER BY replied_on DESC, id LIMIT 51").bind(communityIdentityKey(name), communityIdentityKey(brand), market);
  }
  const { results } = await query.all<Row>();
  return json({ replies: results.slice(0, 50).map(publicReply), more: results.length > 50 });
}
async function review(request: Request, env: Env, id: string): Promise<Response> {
  const value = await parseJson(request);
  if (!Number.isSafeInteger(value.revision) || (value.revision as number) < 0) throw new HttpError(400, 'Reload this submission before reviewing.');
  if (value.decision !== 'approved' && value.decision !== 'rejected') throw new SubmissionError('decision', 'Choose approve or reject.');
  const current = await env.DB.prepare('SELECT * FROM submissions WHERE id = ?').bind(id).first<Row>();
  if (!current) throw new HttpError(404, 'Submission not found.');
  if (current.revision !== value.revision) throw new HttpError(409, 'Another review changed this submission. Reload before saving.');
  const note = typeof value.reviewNote === 'string' ? value.reviewNote.trim() : '';
  if (note.length > 2000) throw new SubmissionError('reviewNote', 'Review notes must be no longer than 2000 characters.');
  const status = value.decision;
  const record = status === 'approved' ? validateCommunitySubmission(value.submission) : null;
  if (status === 'approved' && (!current.evidence_key || !await env.EVIDENCE.head(current.evidence_key))) throw new HttpError(409, 'The evidence is missing. This submission cannot be approved.');
  const evidencePublic = status === 'approved' && value.evidencePublic === true ? 1 : 0;
  const updated = record
    ? await env.DB.prepare(`UPDATE submissions SET product_name=?, name_key=?, brand=?, brand_key=?, barcode=?, market=?, variant=?,
        question=?, reply=?, replied_on=?, claim=?, scope=?, source_url=?, status=?, evidence_public=?, reviewed_at=?, review_note=?, revision=revision+1
        WHERE id=? AND revision=? RETURNING id`).bind(record.productName, communityIdentityKey(record.productName), record.brand,
        communityIdentityKey(record.brand), record.barcode, record.market, record.variant, record.question, record.reply, record.repliedOn,
        record.claim, record.scope, record.sourceUrl, status, evidencePublic, new Date().toISOString(), note, id, value.revision).first()
    : await env.DB.prepare("UPDATE submissions SET status='rejected', evidence_public=0, reviewed_at=?, review_note=?, revision=revision+1 WHERE id=? AND revision=? RETURNING id")
        .bind(new Date().toISOString(), note, id, value.revision).first();
  if (!updated) throw new HttpError(409, 'Another review changed this submission. Reload before saving.');
  // Rejecting a published record immediately removes both its public text and evidence routes.
  return json({ id, status });
}
async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url), path = url.pathname;
  if (request.method === 'GET' && path === '/api/config') return json({ siteKey: env.TURNSTILE_SITE_KEY, submissionsEnabled: env.SUBMISSIONS_ENABLED === 'true' && !!env.TURNSTILE_SECRET, maxEvidenceBytes: MAX_EVIDENCE_BYTES });
  if (request.method === 'POST' && path === '/api/submissions') return submit(request, env);
  if (request.method === 'POST' && path === '/api/reports') return submitReport(request, env);
  if (request.method === 'GET' && path === '/api/replies') return lookup(url, env);
  if (request.method === 'GET' && path === '/api/snapshot') {
    const cursor = url.searchParams.get('cursor') ?? '';
    if (cursor && !idPattern.test(cursor)) throw new HttpError(400, 'Invalid snapshot cursor.');
    const { results } = await env.DB.prepare("SELECT * FROM submissions WHERE status='approved' AND id > ? ORDER BY id LIMIT 201").bind(cursor).all<Row>();
    const page = results.slice(0, 200);
    return json({ schemaVersion: 1, generatedAt: new Date().toISOString(), replies: page.map(publicReply), nextCursor: results.length > 200 ? page.at(-1)!.id : null });
  }
  const evidence = path.match(/^\/api\/evidence\/([^/]+)$/);
  if (request.method === 'GET' && evidence && idPattern.test(evidence[1]!)) {
    const row = await env.DB.prepare("SELECT * FROM submissions WHERE id=? AND status='approved' AND evidence_public=1").bind(evidence[1]).first<Row>();
    if (!row?.evidence_key) throw new HttpError(404, 'Evidence not found.');
    return evidenceResponse(row, env);
  }
  if (path.startsWith('/api/review')) {
    if (!await isAdmin(request, env)) throw new HttpError(401, 'Enter a valid review access code.');
    if (path === '/api/review/reports' || path.startsWith('/api/review/reports/')) return reviewReports(request, env);
    if (request.method === 'GET' && path === '/api/review') {
      const status = url.searchParams.get('status') ?? 'pending';
      if (!['pending', 'approved', 'rejected'].includes(status)) throw new HttpError(400, 'Invalid review status.');
      const cursor = url.searchParams.get('cursor') ?? '';
      if (cursor && !idPattern.test(cursor)) throw new HttpError(400, 'Invalid review cursor.');
      const { results } = await env.DB.prepare('SELECT * FROM submissions WHERE status=? AND id > ? ORDER BY id LIMIT 21').bind(status, cursor).all<Row>();
      const page = results.slice(0, 20);
      return json({ submissions: page.map(row => ({ ...publicReply(row), status: row.status, createdAt: row.created_at,
        reviewNote: row.review_note, revision: row.revision, hasEvidence: !!row.evidence_key, original: JSON.parse(row.original_json) as CommunitySubmission })),
        nextCursor: results.length > 20 ? page.at(-1)!.id : null });
    }
    const match = path.match(/^\/api\/review\/([^/]+)(\/evidence)?$/);
    if (match && idPattern.test(match[1]!)) {
      if (request.method === 'POST' && !match[2]) return review(request, env, match[1]!);
      if (request.method === 'GET' && match[2]) {
        const row = await env.DB.prepare('SELECT * FROM submissions WHERE id=?').bind(match[1]).first<Row>();
        if (!row?.evidence_key) throw new HttpError(404, 'Evidence not found.');
        return evidenceResponse(row, env);
      }
    }
  }
  if (path.startsWith('/api/')) throw new HttpError(404, 'Not found.');
  if (request.method !== 'GET' && request.method !== 'HEAD') throw new HttpError(405, 'Method not allowed.');
  const pages: Record<string, string> = { '/': '/index.html', '/submit': '/index.html', '/replies': '/replies.html', '/review': '/review.html' };
  url.pathname = pages[path] ?? path;
  return env.ASSETS.fetch(new Request(url.toString(), { method: request.method }));
}
async function evidenceResponse(row: Row, env: Env): Promise<Response> {
  const object = await env.EVIDENCE.get(row.evidence_key);
  if (!object) throw new HttpError(404, 'Evidence not found.');
  return new Response(object.body, { headers: { 'Content-Type': row.evidence_type,
    'Content-Disposition': `attachment; filename="manufacturer-reply-${row.id}.${row.evidence_type === 'application/pdf' ? 'pdf' : 'png'}"` } });
}
async function expire(env: Env): Promise<void> {
  const now = Date.now();
  const pending = new Date(now - 30 * 86400_000).toISOString(), rejected = new Date(now - 7 * 86400_000).toISOString();
  const { results } = await env.DB.prepare("SELECT id, evidence_key FROM submissions WHERE (status='pending' AND created_at < ?) OR (status='rejected' AND reviewed_at < ?) LIMIT 100")
    .bind(pending, rejected).all<{ id: string; evidence_key: string }>();
  for (const row of results) {
    // Claim expiry atomically so a concurrent approval cannot lose its attachment.
    const deleted = await env.DB.prepare("DELETE FROM submissions WHERE id=? AND ((status='pending' AND created_at < ?) OR (status='rejected' AND reviewed_at < ?)) RETURNING evidence_key")
      .bind(row.id, pending, rejected).first<{ evidence_key: string }>();
    if (deleted?.evidence_key) await env.EVIDENCE.delete(deleted.evidence_key);
  }
  await env.DB.prepare('DELETE FROM submission_budget WHERE day < ?').bind(new Date(now - 7 * 86400_000).toISOString().slice(0, 10)).run();
  await env.DB.prepare('DELETE FROM report_budget WHERE day < ?').bind(new Date(now - 7 * 86400_000).toISOString().slice(0, 10)).run();
  await env.DB.prepare('DELETE FROM content_reports WHERE created_at < ?').bind(pending).run();
}
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    let response: Response;
    try { response = await route(request, env); }
    catch (error) {
      response = error instanceof SubmissionError ? json({ error: error.message, field: error.field }, 422)
        : error instanceof HttpError || error instanceof ReportError ? json({ error: error.message }, error.status)
        : json({ error: 'The service is temporarily unavailable. Please try again.' }, 503);
    }
    const headers = new Headers(response.headers);
    headers.set('Cache-Control', 'no-store');
    headers.set('Referrer-Policy', 'no-referrer');
    headers.set('X-Content-Type-Options', 'nosniff');
    headers.set('X-Frame-Options', 'DENY');
    headers.set('Content-Security-Policy', "default-src 'self'; script-src 'self' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; connect-src 'self' https://challenges.cloudflare.com; img-src 'self' blob:; style-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'");
    if (response.headers.has('Content-Disposition')) headers.set('Content-Security-Policy', 'sandbox');
    return new Response(response.body, { status: response.status, headers });
  },
  async scheduled(_event: ScheduledController, env: Env): Promise<void> { await expire(env); },
} satisfies ExportedHandler<Env>;
