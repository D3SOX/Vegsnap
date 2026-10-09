import { beforeAll, beforeEach, afterAll, expect, test } from 'bun:test';
import type { Miniflare } from 'miniflare';
import worker, { type Env } from '../src/index';
import { cleanEvidence } from '../src/evidence';
import { fixture, adminToken, submission, png } from './fixture';

let mf: Miniflare, client = 0;
beforeAll(async () => { mf = await fixture(); },30_000);
afterAll(async () => { await mf?.dispose(); });
beforeEach(async () => {
  const db = await mf.getD1Database('DB'); await db.batch(['submissions', 'submission_budget', 'content_reports', 'report_budget'].map(table => db.prepare(`DELETE FROM ${table}`)));
  const bucket = await mf.getR2Bucket('EVIDENCE'); const list = await bucket.list();
  if (list.objects.length) await bucket.delete(list.objects.map(object => object.key));
});
const request = async (path:string, options:RequestInit = {}) => {
  const response = await fetch(new URL(path,await mf.ready),{...options,headers:{...options.headers,Connection:'close'}});
  // Consume bodies even in status-only assertions; oversized uploads cancel their stream.
  return new Response(await response.arrayBuffer(),{status:response.status,headers:response.headers});
};
const reviewHeaders = {Authorization:`Bearer ${adminToken}`,'Content-Type':'application/json'};
async function submit(token = 'valid', origin = 'https://community.example', terms = true) {
  const body = new FormData(); for (const [key,value] of Object.entries(submission)) body.set(key,value);
  body.set('consent','yes'); body.set('terms','yes'); body.set('cf-turnstile-response',token); body.set('evidence',new Blob([png],{type:'image/png'}),'private-name.png');
  if (!terms) body.delete('terms');
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
test('contribution rules must be accepted before uploading evidence', async () => {
  const response = await submit('valid', 'https://community.example', false);
  expect(response.status).toBe(422);
  expect(await response.json()).toMatchObject({field:'terms'});
  expect((await (await mf.getR2Bucket('EVIDENCE')).list()).objects).toHaveLength(0);
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

const approveCoverage = (id: string, coverage: unknown, revision = 0) => request(`/api/review/${id}`,{method:'POST',headers:reviewHeaders,
  body:JSON.stringify({revision,decision:'approved',submission:{...submission,scope:'whole_product',coverage}})});
const product = {productName:submission.productName,brand:submission.brand,barcode:submission.barcode,variant:submission.variant};
test('one reviewed reply covers multiple products and countries with one attachment', async () => {
  const id = await create();
  const coverage = {type:'products',markets:['SE','DE'],products:[product,{...product,productName:'Another drink',barcode:'4006381333931'}]};
  expect((await approveCoverage(id,coverage)).status).toBe(200);
  for (const barcode of [product.barcode,'4006381333931']) for (const market of ['SE','DE']) {
    const body = await (await request(`/api/replies?barcode=${barcode}&market=${market}`)).json() as {replies:{id:string;match:string;productName:string;brand:string;barcode:string;market:string;variant:string}[]};
    expect(body.replies.map(reply=>reply.id)).toEqual([id]); expect(body.replies[0]?.match).toBe('barcode');
    expect(body.replies[0]).toMatchObject({productName:barcode === product.barcode ? product.productName : 'Another drink',
      barcode:barcode.padStart(14,'0'),market,brand:product.brand,variant:product.variant});
  }
  expect(await (await request(`/api/replies?barcode=${product.barcode}&market=US`)).json()).toEqual({replies:[],more:false});
  expect((await (await mf.getR2Bucket('EVIDENCE')).list()).objects).toHaveLength(1);
  expect((await approveCoverage(id,{...coverage,markets:['SE']},0)).status).toBe(409);
  expect((await review(id,1,'rejected')).status).toBe(200);
  expect(await (await request('/api/replies?barcode=4006381333931&market=DE')).json()).toEqual({replies:[],more:false});
});
test('whole-brand range aliases match automatically but never cover the parent company or another country', async () => {
  const id = await create();
  const coverage = {type:'range',markets:['SE'],products:[],range:{name:'Fun Light',wholeBrand:true,brandAliases:['Fun Light','FUN LIGHT'],namePrefixes:['Fun Light']}};
  expect((await approveCoverage(id,coverage)).status).toBe(200);
  const lookup = async (brand: string,market='SE') => (await request(`/api/replies?barcode=4006381333931&name=Drink&brand=${encodeURIComponent(brand)}&market=${market}`)).json() as Promise<{replies:{id:string;match:string}[]}>;
  expect((await lookup(' ＦＵＮ  LIGHT ')).replies[0]).toMatchObject({id,match:'brand'});
  expect((await lookup('Orkla')).replies).toEqual([]);
  expect((await lookup('Fun Light','DE')).replies).toEqual([]);
});
test('range name prefixes suggest coverage and enforce a word boundary', async () => {
  const id = await create();
  const coverage = {type:'range',markets:['SE'],products:[],range:{name:'Fun Light',wholeBrand:false,brandAliases:['Fun Light'],namePrefixes:['Fun Light']}};
  expect((await approveCoverage(id,coverage)).status).toBe(200);
  const value = await (await request('/api/replies?barcode=4006381333931&name=Fun%20Light%20Lemon&brand=Orkla&market=SE')).json() as {replies:unknown[];candidates:{id:string;match:string}[]};
  expect(value.replies).toEqual([]); expect(value.candidates[0]).toMatchObject({id,match:'candidate'});
  expect(await (await request('/api/replies?name=Fun%20Lighter&brand=Orkla&market=SE')).json()).toEqual({replies:[],more:false});
});
test('name fallback finds replies without barcodes but never matches a different known barcode', async () => {
  const id = await create();
  const url = `/api/replies?barcode=4006381333931&name=${encodeURIComponent(product.productName)}&brand=${encodeURIComponent(product.brand)}&market=SE`;
  expect((await approveCoverage(id,{type:'products',markets:['SE'],products:[product]})).status).toBe(200);
  expect(await (await request(url)).json()).toEqual({replies:[],more:false});
  expect((await approveCoverage(id,{type:'products',markets:['SE'],products:[{...product,barcode:''}]},1)).status).toBe(200);
  expect((await (await request(url)).json() as {replies:unknown[]}).replies).toHaveLength(1);
});
test('invalid coverage cannot widen an approved reply', async () => {
  const id = await create();
  for (const coverage of [
    {type:'products',markets:['SE'],products:[{...product,barcode:'3017620422004'}]},
    {type:'products',markets:['US'],products:[product]},
    {type:'range',markets:['SE'],products:[],range:{name:'Fun Light',wholeBrand:true,brandAliases:[],namePrefixes:['Fun Light']}},
  ]) expect((await approveCoverage(id,coverage)).status).toBe(422);
  expect(await (await lookup()).json()).toEqual({replies:[],more:false});
});

test('new submissions retain multi-product coverage privately until review', async () => {
  const body = new FormData(); for (const [key,value] of Object.entries(submission)) body.set(key,value);
  const coverage = {type:'products',markets:['SE'],products:[product,{...product,barcode:'4006381333931',productName:'Other drink'}]};
  body.set('coverage',JSON.stringify(coverage)); body.set('consent','yes'); body.set('terms','yes'); body.set('cf-turnstile-response','valid'); body.set('evidence',new Blob([png],{type:'image/png'}),'evidence.png');
  const response = await request('/api/submissions',{method:'POST',headers:{Origin:'https://community.example','CF-Connecting-IP':`192.0.2.${++client}`},body});
  expect(response.status).toBe(201);
  const id = (await response.json() as {id:string}).id;
  expect(await (await request('/api/replies?barcode=4006381333931&market=SE')).json()).toEqual({replies:[],more:false});
  const queue = await (await request('/api/review',{headers:reviewHeaders})).json() as {submissions:{id:string;coverage:unknown;original:{coverage:unknown}}[]};
  expect(queue.submissions[0]?.coverage).toMatchObject({products:[{barcode:'03017620422003'},{barcode:'04006381333931'}]});
  expect(queue.submissions[0]?.original.coverage).toEqual(queue.submissions[0]?.coverage);
  expect((await approveCoverage(id,coverage)).status).toBe(200);
  expect((await (await request('/api/replies?barcode=4006381333931&market=SE')).json() as {replies:unknown[]}).replies).toHaveLength(1);
});
test('coverage migration backfills existing approved single-product records', async () => {
  const id = await create(); await review(id,0,'approved');
  const db = await mf.getD1Database('DB'); await db.prepare('UPDATE submissions SET coverage_json = NULL, match_rules_json = ? WHERE id = ?').bind('[]',id).run();
  const migration = await Bun.file(new URL('../migrations/0003_reply_coverage.sql',import.meta.url)).text();
  await db.prepare(migration.slice(migration.indexOf('UPDATE submissions')).trim().replace(/;$/,'')).run();
  expect((await (await lookup()).json() as {replies:{id:string}[]}).replies[0]?.id).toBe(id);
});

test('legacy records written or edited during rollout use their current product identity', async () => {
  const id = await create(); await review(id,0,'approved');
  const db = await mf.getD1Database('DB');
  await db.prepare('UPDATE submissions SET barcode = ?, match_rules_json = ? WHERE id = ?').bind('04006381333931','[]',id).run();
  expect(await (await lookup()).json()).toEqual({replies:[],more:false});
  expect((await (await request('/api/replies?barcode=4006381333931&market=SE')).json() as {replies:{id:string}[]}).replies[0]?.id).toBe(id);
});

test('a stale moderator form cannot silently discard reviewed coverage', async () => {
  const id = await create();
  expect((await approveCoverage(id,{type:'range',markets:['SE'],products:[],range:{name:'Fun Light',wholeBrand:true,brandAliases:['Fun Light'],namePrefixes:[]}})).status).toBe(200);
  const stale = await review(id,1,'approved');
  expect(stale.status).toBe(409); expect(await stale.json()).toMatchObject({error:expect.stringContaining('Reload')});
  expect((await (await request('/api/replies?name=Lemon&brand=Fun%20Light&market=SE')).json() as {replies:unknown[]}).replies).toHaveLength(1);
  // Withdrawal remains possible without the coverage editor.
  expect((await review(id,1,'rejected')).status).toBe(200);
});

test('the full migration preserves old records and accepts the old Worker’s writes', async () => {
  const legacy = await fixture(undefined,'127.0.0.1',['0001_submissions.sql','0002_content_reports.sql']);
  try {
    const db = await legacy.getD1Database('DB');
    const oldInsert = (id:string) => db.prepare(`INSERT INTO submissions(id, product_name, name_key, brand, brand_key, barcode, market, variant,
      question, reply, replied_on, claim, scope, source_url, evidence_key, evidence_type, created_at, original_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(id,submission.productName,
      'example oat drink',submission.brand,'example maker','03017620422003',submission.market,submission.variant,
      submission.question,submission.reply,submission.repliedOn,submission.claim,submission.scope,submission.sourceUrl,
      `replies/${id}`,'image/png','2026-01-10T00:00:00Z',JSON.stringify(submission)).run();
    const before = crypto.randomUUID(), during = crypto.randomUUID();
    await oldInsert(before);
    await db.prepare("UPDATE submissions SET status='approved', reviewed_at=?, revision=revision+1 WHERE id=?")
      .bind('2026-01-11T00:00:00Z',before).run();
    const bucket = await legacy.getR2Bucket('EVIDENCE'); await bucket.put(`replies/${before}`,png);
    const migration = await Bun.file(new URL('../migrations/0003_reply_coverage.sql',import.meta.url)).text();
    await db.batch(migration.split(';').map(sql=>sql.trim()).filter(Boolean).map(sql=>db.prepare(sql)));
    await oldInsert(during);
    await db.prepare("UPDATE submissions SET barcode=?, status='approved', reviewed_at=?, revision=revision+1 WHERE id=?")
      .bind('04006381333931','2026-01-11T00:00:00Z',during).run();
    for (const [id,barcode] of [[before,'3017620422003'],[during,'4006381333931']]) {
      const response = await fetch(new URL(`/api/replies?barcode=${barcode}&market=SE`,await legacy.ready),{headers:{Connection:'close'}});
      expect(response.status).toBe(200);
      const page = await response.json() as {replies:Record<string,unknown>[];more:boolean};
      expect(page.more).toBe(false); expect(page.replies).toHaveLength(1);
      expect(page.replies[0]).toMatchObject({...submission,id,barcode:barcode!.padStart(14,'0'),reviewedAt:'2026-01-11T00:00:00Z',evidencePublic:false});
      // Every field read by the released Android parser retains its original type.
      for (const field of ['id','productName','brand','market','variant','question','reply','repliedOn','claim','scope','reviewedAt','sourceUrl'])
        expect(typeof page.replies[0]?.[field]).toBe('string');
    }
    expect(await bucket.head(`replies/${before}`)).not.toBeNull();
    expect(await db.prepare('SELECT COUNT(*) AS count FROM submissions').first('count')).toBe(2);
  } finally { await legacy.dispose(); }
},30_000);

test('restricted-brand aliases without prefixes suggest a range without establishing a verdict', async () => {
  const id = await create();
  expect((await approveCoverage(id,{type:'range',markets:['SE'],products:[],range:{name:'Fun Light',wholeBrand:false,brandAliases:['Fun Light'],namePrefixes:[]}})).status).toBe(200);
  const page = await (await request('/api/replies?barcode=4006381333931&brand=Fun%20Light&market=SE')).json() as {replies:unknown[];candidates:{id:string;match:string}[]};
  expect(page.replies).toEqual([]); expect(page.candidates[0]).toMatchObject({id,match:'candidate'});
});
