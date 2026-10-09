import { Miniflare, Response, convertV4MiniflareOptions } from 'miniflare';
import { resolve } from 'node:path';

export const adminToken = 'integration-test-access-code-never-use-in-production';
export const submission = {productName:'Example oat drink',brand:'Example Maker',barcode:'3017620422003',market:'SE',variant:'Vanilla 1 L',
  question:'Is the vitamin D plant derived?',reply:'Our vitamin D is plant derived.',repliedOn:'2026-01-10',claim:'vegan',scope:'ingredients',sourceUrl:'https://maker.example/reply'};
export const png = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64'));
export async function fixture(port?: number, host = '127.0.0.1', migrations = ['0001_submissions.sql', '0002_content_reports.sql', '0003_reply_coverage.sql']) {
  const root = resolve(import.meta.dir,'..');
  const build = await Bun.build({entrypoints:[resolve(root,'src/index.ts')],target:'browser'});
  if (!build.success) throw new Error(build.logs.join('\n'));
  const mf = new Miniflare(convertV4MiniflareOptions({script:await build.outputs[0]!.text(),modules:true,compatibilityDate:'2026-10-06',
    name:'community-test',port,host,d1Databases:['DB'],r2Buckets:['EVIDENCE'],assets:{directory:resolve(root,'public'),binding:'ASSETS',run_worker_first:true,routerConfig:{has_user_worker:true}},
    ratelimits:{SUBMISSION_LIMIT:{namespace_id:'826401',simple:{limit:5,period:60}}},
    bindings:{PUBLIC_ORIGIN:port ? `http://${host}:${port}` : 'https://community.example',SUBMISSIONS_ENABLED:'true',ADMIN_TOKEN:adminToken,
      TURNSTILE_SITE_KEY:'1x00000000000000000000AA',TURNSTILE_SECRET:'test-only'},
    outboundService:async request => {
      if (request.url !== 'https://challenges.cloudflare.com/turnstile/v0/siteverify') throw new Error('Unexpected outbound request');
      const value = await request.json() as {response:string};
      return Response.json({success:value.response !== 'invalid',hostname:value.response === 'wrong-host' ? 'other.example' : port ? host : 'community.example',action:value.response === 'wrong-action' ? 'other-action' : 'submit-reply'});
    },
  }));
  await mf.ready;
  const db = await mf.getD1Database('DB');
  for (const name of migrations) {
    const migration = await Bun.file(resolve(root, 'migrations', name)).text();
    await db.batch(migration.split(';').map(sql => sql.trim()).filter(Boolean).map(sql => db.prepare(sql)));
  }
  return mf;
}
