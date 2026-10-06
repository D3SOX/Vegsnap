// A disposable test fixture for manual browser checks, never a production deployment.
import { fixture } from './fixture';
const mf = await fixture(8791,process.env.COMMUNITY_TEST_HOST ?? '127.0.0.1');
console.log(`Community test fixture: http://${process.env.COMMUNITY_TEST_HOST ?? '127.0.0.1'}:8791/`);
const stop = async () => { await mf.dispose(); process.exit(0); };
process.on('SIGINT',stop); process.on('SIGTERM',stop);
