import { mkdir, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('.', import.meta.url));
await mkdir(`${root}Vegsnap/Resources/Generated`, { recursive: true });
const result = await Bun.build({ entrypoints: [`${root}Bridge/entry.ts`], target: 'browser', format: 'iife', minify: true });
if (!result.success) throw new AggregateError(result.logs, 'iOS engine bundling failed');
await Bun.write(`${root}Vegsnap/Resources/Generated/core.js`, result.outputs[0]);
await copyFile(`${root}Bridge/runtime.js`, `${root}Vegsnap/Resources/Generated/runtime.js`);
console.log('Prepared the bundled iOS decision engine.');

for (const name of ["hosted-ai", "community-service"]) await copyFile(fileURLToPath(new URL(`../data/${name}.json`, import.meta.url)), `${root}Vegsnap/Resources/Generated/${name}.json`);
