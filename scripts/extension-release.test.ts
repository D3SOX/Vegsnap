import { describe, expect, test } from 'bun:test';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { extensionId, verifyCrx3 } from './extension-release';

const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicKey = keys.publicKey.export({ format: 'der', type: 'spki' });

function varint(value: number): Buffer {
  const bytes = [];
  do {
    bytes.push((value & 127) | (value > 127 ? 128 : 0));
    value = Math.floor(value / 128);
  } while (value);
  return Buffer.from(bytes);
}
function field(number: number, value: Buffer) {
  return Buffer.concat([varint(number * 8 + 2), varint(value.length), value]);
}
function fixture() {
  const zip = Buffer.from('PK\x03\x04example archive payload');
  const signedHeader = field(1, createHash('sha256').update(publicKey).digest().subarray(0, 16));
  const length = Buffer.alloc(4);
  length.writeUInt32LE(signedHeader.length);
  const signature = sign('sha256', Buffer.concat([Buffer.from('CRX3 SignedData\0'), length, signedHeader, zip]), keys.privateKey);
  const header = Buffer.concat([field(2, Buffer.concat([field(1, publicKey), field(2, signature)])), field(10000, signedHeader)]);
  const prefix = Buffer.alloc(12);
  prefix.write('Cr24');
  prefix.writeUInt32LE(3, 4);
  prefix.writeUInt32LE(header.length, 8);
  return Buffer.concat([prefix, header, zip]);
}

describe('Chromium extension identity and signature', () => {
  test('uses the public key digest as the stable extension ID', () => {
    const digest = createHash('sha256').update(publicKey).digest('hex').slice(0, 32);
    const id = extensionId(publicKey);
    expect(id).toHaveLength(32);
    expect(id.replace(/[a-p]/g, digit => (digit.charCodeAt(0) - 97).toString(16))).toBe(digest);
  });
  test('verifies a valid CRX3 proof', () => expect(() => verifyCrx3(fixture(), publicKey)).not.toThrow());
  test('rejects modified contents', () => {
    const bytes = fixture();
    bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1;
    expect(() => verifyCrx3(bytes, publicKey)).toThrow('signature');
  });
  test('rejects another signing identity', () => {
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ format: 'der', type: 'spki' });
    expect(() => verifyCrx3(fixture(), other)).toThrow('identity');
  });
  test('rejects truncated files and unsupported formats', () => {
    expect(() => verifyCrx3(Buffer.from('Cr24'), publicKey)).toThrow();
    expect(() => verifyCrx3(fixture().subarray(0, 15), publicKey)).toThrow('Truncated');
  });
});
