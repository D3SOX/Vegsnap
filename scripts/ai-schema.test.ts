import { expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { generateStrictSchema, strictSchemaPath } from './ai-schema';

test('strict AI output schema is generated from the extraction contract', async () => {
  // Regenerate with bun run schema:generate after changing contracts/ai-extraction.schema.json.
  expect(await readFile(strictSchemaPath, 'utf8')).toBe(await generateStrictSchema());
});

test('strict AI output schema requires every property and allows null only for optional ones', async () => {
  const schema = JSON.parse(await generateStrictSchema());
  const objects: Record<string, unknown>[] = [];
  const walk = (node: unknown) => {
    if (!node || typeof node !== 'object') return;
    if (!Array.isArray(node) && 'properties' in node) objects.push(node as Record<string, unknown>);
    Object.values(node).forEach(walk);
  };
  walk(schema);
  for (const object of objects) {
    expect(object.additionalProperties).toBe(false);
    expect(object.required).toEqual(Object.keys(object.properties as object));
  }
  expect(JSON.stringify(schema)).not.toMatch(/"(?:minLength|maxLength|pattern|format|allOf|uniqueItems|minProperties)"/);
  expect(schema.properties.text.type).toBe('string');
  expect(schema.properties.name.type).toEqual(['string', 'null']);
  expect(schema.properties.contact).toEqual({ anyOf: [{ $ref: '#/$defs/manufacturerContact' }, { type: 'null' }] });
  expect(schema.properties.ingredientAssessments.items.properties.translatedTerm.type).toEqual(['string', 'null']);
});
