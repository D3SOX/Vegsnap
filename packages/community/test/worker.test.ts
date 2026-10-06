import { beforeAll, beforeEach, afterAll, expect, test } from 'bun:test';
import type { Miniflare } from 'miniflare';
import worker, { type Env } from '../src/index';
import { cleanEvidence } from '../src/evidence';
import { fixture, adminToken, submission, png } from './fixture';

let mf: Miniflare, client = 0;
beforeAll(async () => { mf = await fixture(); },30_000);
afterAll(async () => { await mf?.dispose(); });
beforeEach(async () => {
  const db = await mf.getD1Database('DB'); await db.batch([db.prepare('DELETE FROM submissions'),db.prepare('DELETE FROM submission_budget')]);
  const bucket = await mf.getR2Bucket('EVIDENCE'); const list = await bucket.list();
  if (list.objects.length) await bucket.delete(list.objects.map(object => object.key));
});
const request = async (path:string, options:RequestInit = {}) => {
  const response = await fetch(new URL(path,await mf.ready),{...options,headers:{...options.headers,Connection:'close'}});
  // Consume bodies even in status-only assertions; oversized uploads cancel their stream.
  return new Response(await response.arrayBuffer(),{status:response.status,headers:response.headers});
};
const reviewHeaders = {Authorization:`Bearer ${adminToken}`,'Content-Type':'application/json'};
async function submit(token = 'valid', origin = 'https://community.example') {
  const body = new FormData(); for (const [key,value] of Object.entries(submission)) body.set(key,value);
  body.set('consent','yes'); body.set('cf-turnstile-response',token); body.set('evidence',new Blob([png],{type:'image/png'}),'private-name.png');
  return request('/api/submissions',{method:'POST',headers:{Origin:origin,'CF-Connecting-IP':`192.0.2.${++client}`},body});
}
async function create() { const response = await submit(); expect(response.status).toBe(201); return (await response.json() as {id:string}).id; }
const review = (id:string, revision:number, decision:string, evidencePublic = false) => request(`/api/review/${id}`,{method:'POST',headers:reviewHeaders,
  body:JSON.stringify({revision,decision,evidencePublic,submission:{...submission,reply:'Reviewed public reply.'},reviewNote:'PRIVATE MODERATION NOTE'})});
const lookup = () => request('/api/replies?barcode=03017620422003&market=SE');

test('pending submissions and attachments are private, and review access is required',async () => {
  const id = await create();
  expect(await (await lookup()).json()).toEqual({replies:[],more:false});
  expect((await request(`/api/evidence/${id}`)).status).toBe(404);
  expect((await request('/api/review')).status).toBe(401);
  expect((await request(`/api/review/${id}/evidence`)).status).toBe(401);
  expect((await request(`/api/review/${id}/evidence`,{headers:reviewHeaders})).status).toBe(200);
  const queue = await (await request('/api/review',{headers:reviewHeaders})).json() as {submissions:{original:unknown;revision:number}[]};
  expect(queue.submissions[0]?.original).toMatchObject({...submission,barcode:'03017620422003'}); expect(queue.submissions[0]?.revision).toBe(0);
});
test('approval publishes edited text, private attachments stay private, exact market and GTIN are enforced',async () => {
  const id = await create(); expect((await review(id,0,'approved')).status).toBe(200);
  const response = await lookup(), body = await response.text();
  expect(body).toContain('Reviewed public reply.'); expect(body).not.toContain(submission.reply); expect(body).not.toContain('PRIVATE');
  for (const field of ['original','reviewNote','evidence_key','revision','created_at']) expect(body).not.toContain(`"${field}"`);
  expect((await request(`/api/evidence/${id}`)).status).toBe(404);
  expect(await (await request('/api/replies?barcode=3017620422003&market=DE')).json()).toEqual({replies:[],more:false});
  const exact = await request('/api/replies?name=Example%20oat%20drink&brand=EXAMPLE%20MAKER&market=se');
  expect((await exact.json() as {replies:unknown[]}).replies).toHaveLength(1);
  expect((await request('/api/replies?barcode=3017620422004&market=SE')).status).toBe(422);
  expect(response.headers.get('Cache-Control')).toBe('no-store');
});
test('public attachment opt-in, stale reviews and withdrawing approval work',async () => {
  const id = await create(); expect((await review(id,0,'approved',true)).status).toBe(200);
  const evidence = await request(`/api/evidence/${id}`); expect(evidence.status).toBe(200);
  expect(evidence.headers.get('Content-Disposition')).toContain('attachment'); expect(evidence.headers.get('Content-Security-Policy')).toBe('sandbox');
  expect((await review(id,0,'rejected')).status).toBe(409);
  expect((await review(id,1,'rejected')).status).toBe(200);
  expect((await request(`/api/evidence/${id}`)).status).toBe(404);
  expect((await (await lookup()).json() as {replies:unknown[]}).replies).toHaveLength(0);
  expect((await (await request('/api/snapshot')).json() as {replies:unknown[]}).replies).toHaveLength(0);
});
test.each(['invalid','wrong-host','wrong-action'])('challenge failure %s never stores data',async token => {
  expect((await submit(token)).status).toBe(422);
  expect((await (await mf.getR2Bucket('EVIDENCE')).list()).objects).toHaveLength(0);
  expect(await (await mf.getD1Database('DB')).prepare('SELECT COUNT(*) AS count FROM submissions').first('count')).toBe(0);
});
test('same origin and the strict daily budget are required',async () => {
  expect((await submit('valid','https://other.example')).status).toBe(403);
  const db = await mf.getD1Database('DB'); await db.prepare('INSERT INTO submission_budget VALUES (?,100)').bind(new Date().toISOString().slice(0,10)).run();
  expect((await submit()).status).toBe(429); expect((await (await mf.getR2Bucket('EVIDENCE')).list()).objects).toHaveLength(0);
});
test('oversized requests are rejected before storing or parsing attachments',async () => {
  const body = new Uint8Array(2_200_000);
  const response = await request('/api/submissions',{method:'POST',headers:{Origin:'https://community.example','Content-Type':'multipart/form-data; boundary=test','CF-Connecting-IP':`192.0.2.${++client}`},body});
  expect(response.status).toBe(413); expect((await (await mf.getR2Bucket('EVIDENCE')).list()).objects).toHaveLength(0);
});
test('expiry deletes stale pending/rejected records and evidence, preserving approved records',async () => {
  const expired = await create(), approved = await create(), rejected = await create();
  await review(approved,0,'approved'); await review(rejected,0,'rejected');
  const db = await mf.getD1Database('DB'); await db.prepare("UPDATE submissions SET created_at='2000-01-01T00:00:00Z', reviewed_at='2000-01-01T00:00:00Z'").run();
  const env = await mf.getBindings(); await worker.scheduled({} as Parameters<typeof worker.scheduled>[0],env as unknown as Env);
  expect(await db.prepare('SELECT COUNT(*) AS count FROM submissions').first('count')).toBe(1);
  const bucket = await mf.getR2Bucket('EVIDENCE'); expect(await bucket.head(`replies/${expired}`)).toBeNull(); expect(await bucket.head(`replies/${rejected}`)).toBeNull(); expect(await bucket.head(`replies/${approved}`)).not.toBeNull();
});
test('static forms and scripts are served with CSP and without public cache',async () => {
  for (const path of ['/submit','/replies','/review','/submit.js','/common.js']) {
    const response = await request(path); expect(response.status).toBe(200); expect(response.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'");
  }
});
test('evidence validation removes image metadata and rejects disguised or malformed files',() => {
  const prefix = png.slice(0,33), suffix = png.slice(33);
  const payload = new TextEncoder().encode('private email'); const chunk = new Uint8Array(payload.length + 12);
  new DataView(chunk.buffer).setUint32(0,payload.length); chunk.set(new TextEncoder().encode('tEXt'),4); chunk.set(payload,8);
  const withMetadata = new Uint8Array(prefix.length + chunk.length + suffix.length); withMetadata.set(prefix); withMetadata.set(chunk,prefix.length); withMetadata.set(suffix,prefix.length + chunk.length);
  expect(cleanEvidence(withMetadata,'image/png').bytes).toEqual(png);
  expect(() => cleanEvidence(new TextEncoder().encode('<script>bad</script>'),'image/png')).toThrow();
  expect(() => cleanEvidence(png.slice(0,-8),'image/png')).toThrow();
  expect(() => cleanEvidence(png,'application/pdf')).toThrow();
});
