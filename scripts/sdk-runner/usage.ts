import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { query } from '../../packages/sdk-runner/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs';
import { isRecord } from '../../packages/core/src/is-record.ts';
import { CodexEventTranslator } from '../../apps/daemon/src/gateway/codex-stream.ts';
import { frame, parseEvent, SseParser } from '../../apps/daemon/src/gateway/frames.ts';
import { SessionWatch } from '../../packages/sdk-runner/src/session-watch.ts';

const EXPECTED = 24_565;
const MODEL = 'codex:gpt-6-astra';
const ROOT = mkdtempSync(join(tmpdir(), 'sdk-usage-check-'));

function converted(): string {
  const translator = new CodexEventTranslator(MODEL);
  const events = [
    { type: 'response.created', response: { id: 'resp_usage_fixture' } },
    { type: 'response.output_item.added', item: { id: 'msg_usage_fixture', type: 'message' } },
    { type: 'response.output_text.delta', item_id: 'msg_usage_fixture', delta: 'usage fixture done' },
    { type: 'response.output_item.done', item: { id: 'msg_usage_fixture', type: 'message', content: [{ type: 'output_text', text: 'usage fixture done' }] } },
    { type: 'response.completed', response: { id: 'resp_usage_fixture', usage: { input_tokens: EXPECTED, output_tokens: 7, input_tokens_details: { cached_tokens: 10_000 } } } },
  ];
  return events.map((event) => translator.push(event.type, event)).join('') + translator.close();
}

function wireFor(variant: string): string {
  const wire = converted();
  if (variant === 'codex-tail-usage') return wire;
  return new SseParser().push(wire).map((raw) => {
    const parsed = parseEvent(raw);
    assert(parsed !== null);
    if (parsed.event === 'message_start' && isRecord(parsed.data.message)) {
      parsed.data.message.usage = { input_tokens: 14_565, cache_read_input_tokens: 10_000, cache_creation_input_tokens: 0, output_tokens: 0 };
    }
    if (parsed.event === 'message_delta') parsed.data.usage = { output_tokens: 7 };
    return frame(parsed.event, parsed.data);
  }).join('');
}

async function check(variant: string): Promise<void> {
  const fixture = join(ROOT, variant);
  mkdirSync(fixture, { recursive: true });
  const wire = wireFor(variant);
  const server = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.hostname !== '127.0.0.1') return new Response('Only the local fixture is allowed.', { status: 403 });
      const body: unknown = await request.json().catch(() => null);
      if (url.pathname.endsWith('/count_tokens')) return Response.json({ input_tokens: 1 });
      if (url.pathname.endsWith('/messages') && isRecord(body) && body.stream === true) {
        return new Response(wire, { headers: { 'content-type': 'text/event-stream' } });
      }
      return new Response('Unexpected fixture endpoint.', { status: 404 });
    },
  });
  const base = `http://127.0.0.1:${String(server.port)}`;
  const watch = new SessionWatch(() => false);
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), 40_000);
  const session = query({
    prompt: 'Reply once with the fixture text. Do not use any tools.',
    options: {
      cwd: fixture, model: MODEL, settingSources: [], tools: [], mcpServers: {},
      systemPrompt: 'This is an isolated local usage fixture. Reply with plain text only.',
      canUseTool: () => Promise.resolve({ behavior: 'deny', message: 'No tools in this fixture.' }),
      includePartialMessages: true, maxTurns: 1, abortController,
      env: {
        PATH: process.env.PATH, HOME: fixture, CLAUDE_CONFIG_DIR: join(fixture, '.claude'),
        ANTHROPIC_BASE_URL: base, ANTHROPIC_API_KEY: 'fixture-no-real-key',
        HTTP_PROXY: base, HTTPS_PROXY: base, ALL_PROXY: base, NO_PROXY: 'localhost,127.0.0.1',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1',
        DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', CLAUDE_CODE_MCP_STARTUP_WAIT_MS: '0',
      },
    },
  });
  let succeeded = false;
  let assistantContext: number | null = null;
  try {
    for await (const message of session) {
      watch.observe({ ...message });
      if (message.type === 'assistant') assistantContext = watch.context;
      if (message.type === 'result') {
        assert.equal(message.subtype, 'success');
        succeeded = true;
      }
    }
    assert(succeeded);
    assert.equal(assistantContext, variant === 'codex-tail-usage' ? 0 : EXPECTED);
    assert.equal(watch.context, EXPECTED);
    process.stdout.write(`${JSON.stringify({ variant, assistantContext, finalContext: watch.context, pass: true })}\n`);
  } finally {
    clearTimeout(timeout);
    session.close();
    server.stop(true);
  }
}

try {
  for (const variant of ['codex-tail-usage', 'anthropic-start-usage']) await check(variant);
} finally {
  rmSync(ROOT, { recursive: true, force: true });
}
