import { SubmissionError } from '@vegsnap/core/community';
import { validateContentReport, type ContentReport, type ResultReport } from '@vegsnap/core/content-reports';
import type { Env } from './index';

export class ReportError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
// Extension pages send their own per-installation origin on POST requests; web pages cannot use these schemes.
const extensionOrigin = /^(?:chrome|moz|safari-web)-extension:\/\/[a-z0-9-]+$/i;

/** Native reports contain only explicitly reviewed text or verdict context, never attachments or credentials. */
export async function submitReport(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get('Origin');
  if (origin && origin !== env.PUBLIC_ORIGIN && !extensionOrigin.test(origin)) throw new ReportError(403, 'Use Vegsnap to report content.');
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
  let report: ContentReport;
  try { report = validateContentReport(value); }
  catch (error) { if (error instanceof SubmissionError) throw new ReportError(400, error.message); throw error; }
  if (report.kind === 'community' && !await env.DB.prepare("SELECT id FROM submissions WHERE id=? AND status='approved'").bind(report.contentId).first()) throw new ReportError(404, 'This reply is no longer published.');
  const now = new Date().toISOString();
  const budget = await env.DB.prepare('INSERT INTO report_budget(day, count) VALUES (?, 1) ON CONFLICT(day) DO UPDATE SET count=count+1 WHERE count < 200 RETURNING count').bind(now.slice(0, 10)).first();
  if (!budget) throw new ReportError(429, 'The daily report limit has been reached. Try tomorrow.');
  const id = crypto.randomUUID();
  await env.DB.prepare('INSERT INTO content_reports(id, kind, content_id, text, reason, details, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(id, report.kind, report.contentId, report.text, report.reason, report.result ? JSON.stringify(report.result) : '', now).run();
  return Response.json({ id }, { status: 201 });
}

export async function reviewReports(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === 'GET' && url.pathname === '/api/review/reports') {
    const { results } = await env.DB.prepare(`SELECT r.*, s.product_name, s.brand, s.reply, s.revision, s.status AS reply_status
      FROM content_reports r LEFT JOIN submissions s ON r.kind='community' AND s.id=r.content_id
      ORDER BY r.created_at, r.id LIMIT 50`).all<{ details: string }>();
    return Response.json({ reports: results.map(({ details, ...row }) => ({ ...row, details: details ? JSON.parse(details) as ResultReport : null })) });
  }
  const id = url.pathname.substring('/api/review/reports/'.length);
  if (request.method === 'DELETE' && uuid.test(id)) {
    const removed = await env.DB.prepare('DELETE FROM content_reports WHERE id=? RETURNING id').bind(id).first();
    if (!removed) throw new ReportError(404, 'Report not found.');
    return Response.json({ id });
  }
  throw new ReportError(404, 'Not found.');
}
