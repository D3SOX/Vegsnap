import { strict as assert } from 'node:assert';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { packageExtensions } from './extension-release';

// Exercise the actual browser packer and archive contents with a disposable key.
const temporary = await mkdtemp(join(tmpdir(), 'veguide-extension-test-'));
try {
  const keyPath = join(temporary, 'test-key.pem');
  const key = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
  await writeFile(keyPath, key, { mode: 0o600 });
  const chromeDirectory = join(temporary, 'chrome');
  const firefoxDirectory = join(temporary, 'firefox');
  const outputDirectory = join(temporary, 'output');
  const manifest = { name: 'Veguide release packaging test', version: '1.2.3', manifest_version: 3 };
  for (const directory of [chromeDirectory, firefoxDirectory]) {
    await mkdir(directory);
    await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest));
    await writeFile(join(directory, 'marker.txt'), 'packaged successfully');
  }
  const metadata = await packageExtensions({ keyPath, chromeDirectory, firefoxDirectory, outputDirectory, chromiumBinary: process.env.VEGUIDE_CHROMIUM_BINARY });
  const unzip = async (archive: string, entry: string) => {
    const child = Bun.spawn(['unzip', '-p', join(outputDirectory, archive), entry], { stdout: 'pipe', stderr: 'pipe' });
    const [code, output] = await Promise.all([child.exited, new Response(child.stdout).text()]);
    assert.equal(code, 0);
    return output;
  };
  const chromeManifest = JSON.parse(await unzip('veguide-chromium.zip', 'manifest.json'));
  assert.equal(typeof chromeManifest.key, 'string');
  assert.equal(JSON.parse(await readFile(join(chromeDirectory, 'manifest.json'), 'utf8')).key, undefined);
  assert.equal(await unzip('veguide-firefox.xpi', 'marker.txt'), 'packaged successfully');
  assert.equal(JSON.parse(await unzip('veguide-firefox.xpi', 'manifest.json')).key, undefined);
  assert.deepEqual((await readdir(outputDirectory)).sort(), [
    'extension-artifacts.json', 'veguide-chromium.crx', 'veguide-chromium.zip', 'veguide-firefox.xpi',
  ]);
  assert.equal(JSON.parse(await readFile(join(outputDirectory, 'extension-artifacts.json'), 'utf8')).chromium.id, metadata.chromium.id);
  assert.equal(metadata.firefox.signed, false);
  const second = await packageExtensions({ keyPath, chromeDirectory, firefoxDirectory, outputDirectory, chromiumBinary: process.env.VEGUIDE_CHROMIUM_BINARY });
  assert.equal(second.chromium.id, metadata.chromium.id);
  console.log('Extension release packaging passed: CRX3 signature, stable identity, archive contents, unsigned Firefox metadata.');
} finally {
  await rm(temporary, { recursive: true, force: true });
}
