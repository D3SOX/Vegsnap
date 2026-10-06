import { createHash, createPublicKey, verify } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

function publicKeyBytes(privateKey: string): Buffer {
  const key = createPublicKey(privateKey);
  if (key.asymmetricKeyType !== 'rsa') throw new Error('The Chromium extension signing key must be an RSA PEM key.');
  return key.export({ format: 'der', type: 'spki' });
}

export function extensionId(publicKey: Uint8Array): string {
  return createHash('sha256').update(publicKey).digest('hex').slice(0, 32)
    .replace(/[0-9a-f]/g, digit => String.fromCharCode(97 + Number.parseInt(digit, 16)));
}

// CRX3 uses protobuf wire fields. Only length-delimited fields are needed here.
function fields(bytes: Buffer): Map<number, Buffer[]> {
  const result = new Map<number, Buffer[]>();
  let offset = 0;
  const varint = () => {
    let value = 0;
    let shift = 0;
    while (offset < bytes.length && shift < 35) {
      const byte = bytes[offset++]!;
      value += (byte & 127) * 2 ** shift;
      if (!(byte & 128)) return value;
      shift += 7;
    }
    throw new Error('Invalid CRX3 protobuf varint.');
  };
  while (offset < bytes.length) {
    const tag = varint();
    if ((tag & 7) !== 2) throw new Error('Unexpected CRX3 protobuf wire type.');
    const length = varint();
    if (length > bytes.length - offset) throw new Error('Truncated CRX3 protobuf field.');
    const number = Math.floor(tag / 8);
    const values = result.get(number) ?? [];
    values.push(bytes.subarray(offset, offset + length));
    result.set(number, values);
    offset += length;
  }
  return result;
}

export function verifyCrx3(bytes: Buffer, expectedPublicKey: Buffer): void {
  if (bytes.length < 12 || bytes.subarray(0, 4).toString() !== 'Cr24' || bytes.readUInt32LE(4) !== 3) {
    throw new Error('Chromium did not produce a CRX3 extension.');
  }
  const headerSize = bytes.readUInt32LE(8);
  if (headerSize > bytes.length - 12) throw new Error('Truncated CRX3 header.');
  const header = fields(bytes.subarray(12, 12 + headerSize));
  const signedHeader = header.get(10000)?.[0];
  if (!signedHeader) throw new Error('CRX3 signed header is missing.');
  const id = fields(signedHeader).get(1)?.[0];
  if (!id?.equals(createHash('sha256').update(expectedPublicKey).digest().subarray(0, 16))) {
    throw new Error('CRX3 extension identity does not match the persistent signing key.');
  }
  const length = Buffer.alloc(4);
  length.writeUInt32LE(signedHeader.length);
  const signedBytes = Buffer.concat([
    Buffer.from('CRX3 SignedData\0'), length, signedHeader, bytes.subarray(12 + headerSize),
  ]);
  const matches = (header.get(2) ?? []).some(proof => {
    const entries = fields(proof);
    const publicKey = entries.get(1)?.[0];
    const signature = entries.get(2)?.[0];
    return publicKey?.equals(expectedPublicKey) && signature !== undefined && verify(
      'sha256', signedBytes, createPublicKey({ key: publicKey, format: 'der', type: 'spki' }), signature,
    );
  });
  if (!matches) throw new Error('CRX3 signature could not be verified.');
}

async function run(command: string[], cwd?: string) {
  const process = Bun.spawn(command, { cwd, stdout: 'pipe', stderr: 'pipe' });
  const [code, stdout, stderr] = await Promise.all([
    process.exited, new Response(process.stdout).text(), new Response(process.stderr).text(),
  ]);
  if (code !== 0) throw new Error(`${command[0]} failed (${code}): ${stderr || stdout}`);
}

export interface PackageOptions {
  keyPath: string;
  chromiumBinary?: string;
  chromeDirectory?: string;
  firefoxDirectory?: string;
  outputDirectory?: string;
}

export async function packageExtensions(options: PackageOptions) {
  const publicKey = publicKeyBytes(await readFile(options.keyPath, 'utf8'));
  const id = extensionId(publicKey);
  const chromeDirectory = resolve(options.chromeDirectory ?? 'extension/.output/chrome-mv3');
  const firefoxDirectory = resolve(options.firefoxDirectory ?? 'extension/.output/firefox-mv3');
  const outputDirectory = resolve(options.outputDirectory ?? 'release-assets');
  const chromeManifest: Record<string, unknown> = JSON.parse(await readFile(join(chromeDirectory, 'manifest.json'), 'utf8'));
  const firefoxManifest: Record<string, unknown> = JSON.parse(await readFile(join(firefoxDirectory, 'manifest.json'), 'utf8'));
  if (typeof chromeManifest.version !== 'string' || chromeManifest.version !== firefoxManifest.version) {
    throw new Error('Both browser builds must have the same extension version.');
  }
  await mkdir(outputDirectory, { recursive: true });
  const temporary = await mkdtemp(join(tmpdir(), 'veguide-extension-release-'));
  try {
    const staged = join(temporary, 'chromium');
    await cp(chromeDirectory, staged, { recursive: true });
    await writeFile(join(staged, 'manifest.json'), JSON.stringify({ ...chromeManifest, key: publicKey.toString('base64') }, null, 2));
    await run([
      options.chromiumBinary ?? 'chromium', '--headless=new', '--no-first-run', '--no-message-box',
      `--user-data-dir=${join(temporary, 'profile')}`, `--pack-extension=${staged}`,
      `--pack-extension-key=${resolve(options.keyPath)}`,
    ]);
    const crx = await readFile(`${staged}.crx`);
    verifyCrx3(crx, publicKey);
    await writeFile(join(outputDirectory, 'veguide-chromium.crx'), crx);
    // Write fresh archives: zip updates existing archives rather than removing stale entries.
    for (const [name, directory] of [['veguide-chromium.zip', staged], ['veguide-firefox.xpi', firefoxDirectory]] as const) {
      const archive = join(outputDirectory, name);
      await rm(archive, { force: true });
      await run(['zip', '-q', '-r', archive, '.'], directory);
      await run(['unzip', '-tq', archive]);
    }
    const metadata = {
      version: chromeManifest.version,
      chromium: { id, package: 'veguide-chromium.crx', unpacked: 'veguide-chromium.zip', signature: 'CRX3' },
      firefox: { package: 'veguide-firefox.xpi', signed: false, installation: 'Temporary installation through about:debugging; permanent installation requires Mozilla signing or a Firefox edition permitting unsigned extensions.' },
    };
    await writeFile(join(outputDirectory, 'extension-artifacts.json'), `${JSON.stringify(metadata, null, 2)}\n`);
    return metadata;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const keyPath = process.env.VEGUIDE_EXTENSION_KEY_PATH;
  if (!keyPath) throw new Error('Set VEGUIDE_EXTENSION_KEY_PATH to the persistent RSA PEM signing key.');
  console.log(JSON.stringify(await packageExtensions({
    keyPath,
    chromiumBinary: process.env.VEGUIDE_CHROMIUM_BINARY,
    outputDirectory: process.argv[2],
  }), null, 2));
}
