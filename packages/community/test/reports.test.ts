import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import type { Miniflare } from 'miniflare';
import worker, { type Env } from '../src/index';
import { fixture, adminToken, submission, png } from './fixture';

let mf: Miniflare, client = 0;
beforeAll(async () => { mf = await fixture(); }, 30_000);
afterAll(async () => { await mf?.dispose(); });
beforeEach(async () => {
  const db = await mf.getD1Database('DB');
  await db.batch(['content_reports', 'report_budget', 'submissions', 'submission_budget'].map(table => db.prepare(`DELETE FROM ${table}`)));
});
const report = { kind: 'ai', contentId: '', text: 'Reviewed AI excerpt', reason: 'Offensive content' };
const auth = { Authorization: `Bearer ${adminToken}` };
const request = async (path: string, options: RequestInit = {}) => {
  const response = await fetch(new URL(path, await mf.ready), { ...options, headers: { ...options.headers, Connection: 'close' } });
  return new Response(await response.arrayBuffer(), { status: response.status, headers: response.headers });
};
const submit = (body: unknown = report, headers: Record<string, string> = {}) => request('/api/reports', {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': `192.0.2.${++client}`, ...headers }, body: JSON.stringify(body),
});

test('native reports stay private and require moderator authentication to view and delete', async () => {
  const response = await submit(); expect(response.status).toBe(201);
  const { id } = await response.json() as { id: string };
  expect((await request('/api/review/reports')).status).toBe(401);
  expect((await request(`/api/review/reports/${id}`, { method: 'DELETE' })).status).toBe(401);
  const queue = await request('/api/review/reports', { headers: auth });
  const text = await queue.text(); expect(text).toContain(report.text); expect(text).not.toContain('192.0.2.');
  expect(queue.headers.get('Cache-Control')).toBe('no-store');
  expect(await (await request('/api/snapshot')).text()).not.toContain(report.text);
  expect((await request(`/api/review/reports/${id}`, { method: 'DELETE', headers: auth })).status).toBe(200);
  expect(await (await request('/api/review/reports', { headers: auth })).json()).toEqual({ reports: [] });
});
test('unknown fields invalid references and invalid lengths never enter the report database', async () => {
  for (const body of [{ ...report, credentials: 'private' }, { ...report, reason: '' }, { ...report, text: 'x'.repeat(8001) },
    { ...report, contentId: 'private-history-id' }, { kind: 'community', contentId: 'bad', text: '', reason: 'Issue' }, []]) {
    expect((await submit(body)).status).toBe(400);
  }
  expect((await submit({ kind: 'community', contentId: '12345678-1234-4234-8234-123456789abc', text: '', reason: 'Issue' })).status).toBe(404);
  expect(await (await mf.getD1Database('DB')).prepare('SELECT COUNT(*) FROM content_reports').first('COUNT(*)')).toBe(0);
});
test('moderators can inspect and withdraw a reported published reply before clearing its report', async () => {
  const body = new FormData();
  for (const [key, value] of Object.entries(submission)) body.set(key, value);
  body.set('consent', 'yes'); body.set('terms', 'yes'); body.set('cf-turnstile-response', 'valid');
  body.set('evidence', new Blob([png], { type: 'image/png' }), 'test.png');
  const created = await request('/api/submissions', { method: 'POST', headers: { Origin: 'https://community.example', 'CF-Connecting-IP': `192.0.2.${++client}` }, body });
  expect(created.status).toBe(201);
  const { id } = await created.json() as { id: string };
  const reviewHeaders = { ...auth, 'Content-Type': 'application/json' };
  expect((await request(`/api/review/${id}`, { method: 'POST', headers: reviewHeaders, body: JSON.stringify({ revision: 0, decision: 'approved', submission, evidencePublic: false }) })).status).toBe(200);
  const reported = await submit({ kind: 'community', contentId: id, text: '', reason: 'Harmful reply' });
  expect(reported.status).toBe(201);
  const { id: reportId } = await reported.json() as { id: string };
  const queue = await (await request('/api/review/reports', { headers: auth })).json() as { reports: { content_id: string; reply: string; revision: number; reply_status: string }[] };
  expect(queue.reports[0]).toMatchObject({ content_id: id, reply: submission.reply, revision: 1, reply_status: 'approved' });
  expect((await request(`/api/review/${id}`, { method: 'POST', headers: reviewHeaders, body: JSON.stringify({ revision: 1, decision: 'rejected', reviewNote: 'Withdrawn after a content report.' }) })).status).toBe(200);
  expect(await (await request('/api/replies?barcode=03017620422003&market=SE')).json()).toEqual({ replies: [], more: false });
  expect((await submit({ kind: 'community', contentId: id, text: '', reason: 'Another report' })).status).toBe(404);
  expect((await request(`/api/review/reports/${reportId}`, { method: 'DELETE', headers: auth })).status).toBe(200);
});
test('repeated reports from one client reach the per-minute limit', async () => {
  const headers = { 'CF-Connecting-IP': '198.51.100.44' };
  for (let i = 0; i < 5; i++) expect((await submit(report, headers)).status).toBe(201);
  expect((await submit(report, headers)).status).toBe(429);
});
test('cross-origin reports oversized bodies and the daily cap are rejected', async () => {
  expect((await submit(report, { Origin: 'https://other.example' })).status).toBe(403);
  expect((await submit({ ...report, text: 'x'.repeat(48_000) })).status).toBe(413);
  const db = await mf.getD1Database('DB');
  await db.prepare('INSERT INTO report_budget VALUES (?,200)').bind(new Date().toISOString().slice(0, 10)).run();
  expect((await submit()).status).toBe(429);
});
test('hourly cleanup removes expired reports and old budgets', async () => {
  expect((await submit()).status).toBe(201);
  const db = await mf.getD1Database('DB');
  await db.prepare("UPDATE content_reports SET created_at='2000-01-01T00:00:00Z'").run();
  await db.prepare("UPDATE report_budget SET day='2000-01-01'").run();
  await worker.scheduled({} as Parameters<typeof worker.scheduled>[0], await mf.getBindings() as unknown as Env);
  expect(await db.prepare('SELECT COUNT(*) FROM content_reports').first('COUNT(*)')).toBe(0);
  expect(await db.prepare('SELECT COUNT(*) FROM report_budget').first('COUNT(*)')).toBe(0);
});
