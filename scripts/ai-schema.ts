import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

type Schema = { [key: string]: unknown };
const root = fileURLToPath(new URL('../', import.meta.url));
export const strictSchemaPath = `${root}contracts/ai-output.schema.json`;
// Keywords outside OpenAI's strict Structured Outputs subset; the client validators still enforce them.
const unsupported = new Set(['$schema', 'minLength', 'maxLength', 'pattern', 'format', 'uniqueItems', 'minProperties', 'allOf', 'anyOf']);

/** Derive the strict request schema: every property required, optional ones nullable. Clients strip nulls before validation. */
export function strictSchema(schema: Schema): Schema {
  const result: Schema = Object.fromEntries(Object.entries(schema).filter(([key]) => !unsupported.has(key)));
  if (result.enum && !result.type) result.type = 'string';
  if (result.items) result.items = strictSchema(result.items as Schema);
  if (result.$defs) result.$defs = Object.fromEntries(Object.entries(result.$defs as Record<string, Schema>).map(([key, value]) => [key, strictSchema(value)]));
  if (result.properties) {
    const required = new Set(result.required as string[] | undefined);
    result.properties = Object.fromEntries(Object.entries(result.properties as Record<string, Schema>).map(([key, value]) => {
      const property = strictSchema(value);
      if (required.has(key)) return [key, property];
      return [key, property.$ref ? { anyOf: [property, { type: 'null' }] }
        : { ...property, type: [property.type, 'null'], ...(property.enum ? { enum: [...property.enum as unknown[], null] } : {}) }];
    }));
    result.required = Object.keys(result.properties as Schema);
  }
  return result;
}

export async function generateStrictSchema(): Promise<string> {
  const contract = JSON.parse(await readFile(`${root}contracts/ai-extraction.schema.json`, 'utf8')) as Schema;
  return `${JSON.stringify(strictSchema(contract), null, 2)}\n`;
}

if (import.meta.main) {
  await writeFile(strictSchemaPath, await generateStrictSchema());
  console.log('Generated contracts/ai-output.schema.json.');
}
