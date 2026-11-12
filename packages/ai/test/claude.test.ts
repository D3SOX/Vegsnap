import { expect, test } from 'bun:test';
import Anthropic from '@anthropic-ai/sdk';
import type { AIPass } from '@vegsnap/core';
import { createClaudeRunner } from '../src/claude';

const pass: AIPass = { instructions: 'Read the label.', context: '{}', images: [], searches: 2, requireSearch: true, output: {} };
const answer = JSON.stringify({ text: '', complete: false, category: 'food', name: 'Oats', brand: 'Maker' });
function runner(replies: { stop_reason: string; content: unknown[] }[]) {
  const requests: Record<string, unknown>[] = [];
  let billed = 0;
  const fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body)));
    const reply = replies[requests.length - 1]!;
    return Response.json({ id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 }, ...reply });
  }) as typeof globalThis.fetch;
  const run = createClaudeRunner(new Anthropic({ apiKey: 'test', fetch, maxRetries: 0 }), 'claude-sonnet-5-5', () => { billed++; });
  return { run: () => run(pass, new AbortController().signal), requests, billed: () => billed };
}
const search = (url: string) => [{ type: 'server_tool_use', id: url, name: 'web_search', input: { query: 'oats' } },
  { type: 'web_search_tool_result', tool_use_id: url, content: [{ type: 'web_search_result', url, title: 'Source', encrypted_content: 'x', page_age: null }] }];

test('a paused search turn resumes and keeps sources from before the pause', async () => {
  const { run, requests, billed } = runner([
    { stop_reason: 'pause_turn', content: search('https://maker.example/a') },
    { stop_reason: 'end_turn', content: [...search('https://maker.example/b'), { type: 'text', text: `Here is the result:\n${answer}` }] },
  ]);
  const result = await run();
  expect(result.searches).toBe(2);
  expect(result.extraction).toMatchObject({ name: 'Oats', research: { searched: true, sources: [{ url: 'https://maker.example/a' }, { url: 'https://maker.example/b' }] } });
  expect(requests[1]).toMatchObject({ messages: [{ role: 'user' }, { role: 'assistant' }] });
  expect(requests[0]?.system).toMatchObject([{ text: expect.stringContaining('Search the web with the web_search tool') }]);
  expect(billed()).toBe(2);
});

test('refused or truncated answers are never accepted as verdicts', async () => {
  for (const stop_reason of ['refusal', 'max_tokens']) {
    const { run, billed } = runner([{ stop_reason, content: [{ type: 'text', text: answer }] }]);
    await expect(run()).rejects.toThrow('no verdict was accepted');
    expect(billed()).toBe(1);
  }
});
