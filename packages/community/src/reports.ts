import type { Env } from './index';

export class ReportError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Native reports contain only explicitly reviewed text, never attachments or credentials. */
export async function submitReport(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get('Origin');
  if (origin && origin !== env.PUBLIC_ORIGIN) throw new ReportError(403, 'Use Vegsnap to report content.');
  if (!request.headers.get('Content-Type')?.startsWith('application/json')) throw new ReportError(415, 'Use a JSON request.');
  const { success } = await env.SUBMISSION_LIMIT.limit({ key: `report:${request.headers.get('CF-Connecting-IP') ?? 'unknown'}` });
  if (!success) throw new ReportError(429, 'Too many reports. Try again in a minute.');
  const reader = request.body?.getReader();
  if (!reader) throw new ReportError(400, 'The report is missing.');
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > 48_000) { await reader.cancel(); throw new ReportError(413, 'The report is too large.'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  let value: unknown;
  try { value = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new ReportError(400, 'Invalid report.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ReportError(400, 'Invalid report.');
  const report = value as Record<string, unknown>;
  if (Object.keys(report).some(key => !['kind', 'contentId', 'text', 'reason'].includes(key))) throw new ReportError(400, 'Unexpected report fields.');
  const { kind, contentId, text, reason } = report;
  if ((kind !== 'ai' && kind !== 'community') || typeof contentId !== 'string' || typeof text !== 'string' ||
      typeof reason !== 'string' || !reason.trim() || reason.length > 2000 || text.length > 8000) throw new ReportError(400, 'Check the report text and reason.');
  if (kind === 'ai' && (contentId !== '' || !text.trim())) throw new ReportError(400, 'Include the AI text you want to report.');
  if (kind === 'community') {
    if (!uuid.test(contentId) || text !== '') throw new ReportError(400, 'Invalid community reply reference.');
    if (!await env.DB.prepare("SELECT id FROM submissions WHERE id=? AND status='approved'").bind(contentId).first()) throw new ReportError(404, 'This reply is no longer published.');
  }
  const now = new Date().toISOString();
  const budget = await env.DB.prepare('INSERT INTO report_budget(day, count) VALUES (?, 1) ON CONFLICT(day) DO UPDATE SET count=count+1 WHERE count < 200 RETURNING count').bind(now.slice(0, 10)).first();
  if (!budget) throw new ReportError(429, 'The daily report limit has been reached. Try tomorrow.');
  const id = crypto.randomUUID();
  await env.DB.prepare('INSERT INTO content_reports(id, kind, content_id, text, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(id, kind, contentId, text.trim(), reason.trim(), now).run();
  return Response.json({ id }, { status: 201 });
}

export async function reviewReports(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === 'GET' && url.pathname === '/api/review/reports') {
    const { results } = await env.DB.prepare(`SELECT r.*, s.product_name, s.brand, s.reply, s.revision, s.status AS reply_status
      FROM content_reports r LEFT JOIN submissions s ON r.kind='community' AND s.id=r.content_id
      ORDER BY r.created_at, r.id LIMIT 50`).all();
    return Response.json({ reports: results });
  }
  const id = url.pathname.substring('/api/review/reports/'.length);
  if (request.method === 'DELETE' && uuid.test(id)) {
    const removed = await env.DB.prepare('DELETE FROM content_reports WHERE id=? RETURNING id').bind(id).first();
    if (!removed) throw new ReportError(404, 'Report not found.');
    return Response.json({ id });
  }
  throw new ReportError(404, 'Not found.');
}
