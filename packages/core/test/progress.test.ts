import { expect, test } from 'bun:test';
import { checkProduct, type CheckStage } from '../src';

test('progress reports the actual database and provider work before evaluating its result', async () => {
  const stages: CheckStage[] = [];
  let lookups = 0;
  let analyses = 0;
  const result = await checkProduct({ barcode: '4006381333931', text: 'unknown ingredient' }, {
    mode: 'explicit', onProgress: stage => stages.push(stage),
    fetch: (async () => {
      expect(stages.at(-1)).toBe('database');
      lookups++;
      return new Response(JSON.stringify({ status: 0 }));
    }) as unknown as typeof fetch,
    provider: { async extract() {
      expect(stages.at(-1)).toBe('ai');
      analyses++;
      return { text: 'unknown ingredient', complete: false, category: 'food' };
    } },
  });
  expect(lookups).toBeGreaterThan(0);
  expect(analyses).toBe(1);
  expect(stages).toEqual(['evaluating', 'database', 'ai', 'evaluating']);
  expect(result.usedAI).toBe(true);
});

test('offline checks never advertise network or AI progress', async () => {
  const stages: CheckStage[] = [];
  await checkProduct({ barcode: '4006381333931', text: 'unknown ingredient' }, {
    mode: 'explicit', offline: true, onProgress: stage => stages.push(stage),
    provider: { async extract() { throw new Error('Offline must not invoke a provider'); } },
  });
  expect(stages).toEqual(['evaluating']);
});
