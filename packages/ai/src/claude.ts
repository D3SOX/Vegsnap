import type Anthropic from '@anthropic-ai/sdk';
import { aiOutputSchema, parseAIExtraction, safeSourceUrl, type AIPass, type AIPassRunner } from '@vegsnap/core';

/** Label reading runs at low effort for speed; search passes weigh conflicting sources and get more. */
const READ_EFFORT = 'low';
const SEARCH_EFFORT = 'medium';
/** The server pauses long search turns; a pass may resume this many times. */
const MAX_RESUMES = 2;

function imageBlock(dataUrl: string): Anthropic.ImageBlockParam {
  const match = /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/.exec(dataUrl);
  if (!match) throw new Error('Use a locally sanitized JPEG, PNG or WebP photo.');
  return { type: 'image', source: { type: 'base64', media_type: match[1] as 'image/jpeg' | 'image/png' | 'image/webp', data: match[2]! } };
}
/** JSON outputs cannot be combined with web search citations, so the schema is part of the cached system prompt. */
function system(pass: AIPass): Anthropic.TextBlockParam[] {
  const required = pass.requireSearch ? '\nSearch the web with the web_search tool before answering; this request exists to find web evidence.' : '';
  return [{ type: 'text', cache_control: { type: 'ephemeral' }, text: `${pass.instructions}${required}
Reply with only the JSON object, without Markdown or commentary, matching this JSON Schema:
${JSON.stringify(aiOutputSchema(pass.output))}` }];
}
/** Text after the last search holds the answer; citations may split it into several blocks. */
function answer(content: Anthropic.ContentBlock[]): string {
  const last = content.map(block => block.type === 'web_search_tool_result' || block.type === 'server_tool_use').lastIndexOf(true);
  const text = content.slice(last + 1).flatMap(block => block.type === 'text' ? [block.text] : []).join('');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('AI provider returned no completion.');
  return text.slice(start, end + 1);
}
/**
 * Runs one Vegsnap pass on Claude. Search provenance comes from the API's search results, never from the model's JSON.
 * `onResponse` fires for every completed (billable) API response.
 */
export function createClaudeRunner(client: Anthropic, model: string, onResponse: () => void = () => {}): AIPassRunner {
  return async (pass, signal) => {
    const messages: Anthropic.MessageParam[] = [{ role: 'user', content: [...pass.images.map(imageBlock), { type: 'text', text: pass.context }] }];
    const content: Anthropic.ContentBlock[] = [];
    for (let resume = 0; ; resume++) {
      const response = await client.messages.create({
        model, max_tokens: 16_000, system: system(pass), messages,
        output_config: { effort: pass.searches ? SEARCH_EFFORT : READ_EFFORT },
        ...(pass.searches ? { tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: pass.searches }] } : {}),
      }, { signal });
      onResponse();
      content.push(...response.content);
      if (response.stop_reason === 'pause_turn' && resume < MAX_RESUMES) {
        messages.push({ role: 'assistant', content: response.content });
        continue;
      }
      if (response.stop_reason === 'refusal') throw new Error('AI response was refused; no verdict was accepted.');
      if (response.stop_reason !== 'end_turn') throw new Error('AI response was incomplete; no verdict was accepted.');
      break;
    }
    const sources = new Map<string, { url: string; title: string }>();
    let searched = false;
    let searches = 0;
    for (const block of content) {
      if (block.type === 'server_tool_use' && block.name === 'web_search') searches++;
      if (block.type !== 'web_search_tool_result' || !Array.isArray(block.content)) continue;
      searched = true;
      for (const result of block.content) {
        if (result.url.length > 2000 || !safeSourceUrl(result.url) || sources.size >= 50 && !sources.has(result.url)) continue;
        sources.set(result.url, { url: result.url, title: result.title.slice(0, 300) });
      }
    }
    const extraction = parseAIExtraction(answer(content));
    return { searches, extraction: { ...extraction, research: { searched, sources: searched ? [...sources.values()] : [] } } };
  };
}
