import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createCatalog } from './regional-catalog';

test('published catalog describes the exact checked-in pack bytes', async () => {
  const catalog = await createCatalog('https://example.org/releases/v1/');
  expect(catalog.packs.map(pack => pack.id)).toEqual(['germany', 'sweden', 'eu']);
  for (const pack of catalog.packs) {
    const bytes = await readFile(`regional-packs/${pack.id}.json`);
    expect(pack.bytes).toBe(bytes.length);
    expect(pack.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(pack.url).toBe(`https://example.org/releases/v1/${pack.id}.json`);
    expect(pack.products).toBe(JSON.parse(bytes.toString()).products.length);
  }
});

test('catalog refuses insecure or credential-bearing download bases', async () => {
  for (const url of ['http://example.org/', 'https://user:secret@example.org/', 'https://example.org/?token=secret']) {
    await expect(createCatalog(url)).rejects.toThrow('plain HTTPS');
  }
});
