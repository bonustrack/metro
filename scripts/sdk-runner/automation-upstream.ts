import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer, type ServerResponse } from 'node:http';
import type { AutomationRequest, AutomationOutcome } from '../../packages/core/src/automation-types.ts';

interface Block {
  type: string;
  text?: string;
  tool_use_id?: string;
  content?: string | Block[];
  is_error?: boolean;
}

interface Request {
  model: string;
  stream?: boolean;
  messages?: { role: string; content: string | Block[] }[];
}

interface Action {
  name: string;
  id: string;
  input: Record<string, unknown>;
}

export interface Delivery {
  uuid: string;
  token: string;
  routine: string;
  finishCommand: string;
}

function stream(res: ServerResponse, model: string, text: string, action?: Action): void {
  if (res.destroyed) return;
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const emit = (event: string, data: object): void => { res.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`); };
  emit('message_start', { message: { id: `msg_${randomUUID()}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 50, output_tokens: 1 } } });
  emit('content_block_start', { index: 0, content_block: action === undefined ? { type: 'text', text: '' } : { type: 'tool_use', id: action.id, name: action.name, input: {} } });
  emit('content_block_delta', { index: 0, delta: action === undefined ? { type: 'text_delta', text } : { type: 'input_json_delta', partial_json: JSON.stringify(action.input) } });
  emit('content_block_stop', { index: 0 });
  emit('message_delta', { delta: { stop_reason: action === undefined ? 'end_turn' : 'tool_use', stop_sequence: null }, usage: { output_tokens: 7 } });
  emit('message_stop', {});
  res.end();
}

export async function automationUpstream() {
  const expected = new Map<string, { request: AutomationRequest; outcome: AutomationOutcome; bash: boolean }>();
  const deliveries = new Map<string, Delivery>();
  const hold = new Set<string>();
  const held = new Map<string, { res: ServerResponse; model: string }>();
  const scheduled: { uuid: string; text: string }[] = [];
  const workers: string[] = [];
  const chats: string[] = [];
  const acknowledgments: string[] = [];
  const errors: string[] = [];
  const bashCommands = new Map<string, { uuid: string; command: string }>();
  const bashResults: { uuid: string; toolUseId: string; output: string }[] = [];
  let requests = 0;

  function bash(res: ServerResponse, model: string, uuid: string, step: string, command: string): void {
    const id = `toolu_${step}_${uuid}`;
    bashCommands.set(id, { uuid, command });
    stream(res, model, '', { name: 'Bash', id, input: { command, description: 'Verify isolated automation completion', timeout: 10_000 } });
  }

  function effect(res: ServerResponse, model: string, delivery: Delivery): void {
    stream(res, model, '', { name: 'mcp__metro__fixture_effect', id: `toolu_effect_${delivery.uuid}`, input: { uuid: delivery.uuid, token: delivery.token } });
  }

  function finish(res: ServerResponse, model: string, uuid: string): void {
    const delivery = deliveries.get(uuid);
    const plan = expected.get(uuid);
    assert.ok(delivery && plan, 'only a previously dispatched fixture can finish');
    if (plan.bash) {
      assert.equal(plan.outcome, 'completed');
      bash(res, model, uuid, 'bash_finish', delivery.finishCommand);
    } else stream(res, model, '', { name: 'mcp__metro__fixture_finish', id: `toolu_finish_${uuid}`, input: { uuid, token: delivery.token, outcome: plan.outcome } });
  }

  function answer(body: Request, res: ServerResponse): void {
    if (body.stream !== true) {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: 'msg_helper', type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 5, output_tokens: 5 } }));
      return;
    }
    const messages = body.messages ?? [];
    const fresh = messages.slice(messages.findLastIndex((message) => message.role === 'assistant') + 1);
    const blocks = fresh.flatMap((message) => typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content);
    const result = blocks.find((block) => block.type === 'tool_result');
    const after = result?.tool_use_id;
    const text = blocks.map((block) => block.text ?? '').join('\n');
    const command = after === undefined ? undefined : bashCommands.get(after);
    if (command !== undefined && result !== undefined && after !== undefined) {
      const output = typeof result.content === 'string' ? result.content : (result.content ?? []).map((block) => block.text ?? '').join('\n');
      assert.notEqual(result.is_error, true, `actual worker Bash failed: ${output}`);
      bashResults.push({ uuid: command.uuid, toolUseId: after, output });
      if (after.startsWith('toolu_probe_')) {
        const delivery = deliveries.get(command.uuid);
        assert.ok(delivery);
        effect(res, body.model, delivery);
      } else {
        const receipt = JSON.parse(/^\{"status":"accepted"[^\n]+/m.exec(output)?.[0] ?? 'null') as { uuid: string; requestedOutcome: string } | null;
        assert.equal(receipt?.uuid, command.uuid, `actual CLI must return its receipt: ${output}`);
        assert.equal(receipt?.requestedOutcome, 'completed');
        stream(res, body.model, 'Actual worker Bash completion receipt recorded.');
      }
      return;
    }
    if (after?.startsWith('toolu_effect_') === true) {
      const uuid = after.slice('toolu_effect_'.length);
      if (hold.has(uuid)) held.set(uuid, { res, model: body.model });
      else finish(res, body.model, uuid);
      return;
    }
    if (after !== undefined) { stream(res, body.model, 'Fixture tool receipt recorded.'); return; }
    const ack = text.match(/\[metro-task-handled:[A-Za-z0-9-]+\]/g);
    if (ack !== null) {
      acknowledgments.push(...ack);
      stream(res, body.model, ack.join('\n'));
      return;
    }
    if (text.includes('[Metro local automation.')) {
      const uuid = /^Delivery: ([0-9a-f-]+)$/m.exec(text)?.[1];
      const token = /^Completion token: ([0-9a-f-]+)$/m.exec(text)?.[1];
      const routine = /^Routine: (.+)$/m.exec(text)?.[1];
      const stored = /Stored prompt, JSON encoded:\n([^\n]+)/.exec(text)?.[1];
      const finishCommand = /its worker must run this exact command:\n([^\n]+)/.exec(text)?.[1];
      assert.ok(uuid && token && routine && stored && finishCommand, 'real scheduled input includes identifiers, encoded prompt and executable finish command');
      assert.ok(finishCommand.startsWith(`BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 '${process.execPath}' '--no-install' '`));
      assert.equal(text.includes('<channel'), false, 'scheduled input is not forged chat');
      const plan = expected.get(uuid);
      assert.ok(plan, 'no unplanned automation dispatch');
      assert.equal(plan.request.routine, routine);
      assert.equal(JSON.parse(stored), plan.request.prompt);
      const delivery = { uuid, token, routine, finishCommand };
      deliveries.set(uuid, delivery);
      scheduled.push({ uuid, text });
      stream(res, body.model, '', { name: 'Agent', id: `toolu_launch_${uuid}`, input: { description: 'Isolated automation proof', prompt: `AUTOMATION_WORKER ${JSON.stringify(delivery)}`, subagent_type: 'worker', run_in_background: true } });
      return;
    }
    const worker = /^AUTOMATION_WORKER (\{[^\n]+\})$/m.exec(text)?.[1];
    if (worker !== undefined) {
      const delivery = JSON.parse(worker) as Delivery;
      assert.deepEqual(deliveries.get(delivery.uuid), delivery, 'worker carries only the dispatched fixture identifiers');
      workers.push(delivery.uuid);
      if (expected.get(delivery.uuid)?.bash) {
        bash(res, body.model, delivery.uuid, 'probe', `printf '%s\\n' "FIXTURE_HOME=$HOME" "FIXTURE_STATE=$METRO_RUNNER_STATE" "FIXTURE_PATH=$PATH" "FIXTURE_METRO=$(command -v metro || true)" "FIXTURE_CACHE=$BUN_RUNTIME_TRANSPILER_CACHE_PATH"`);
      } else effect(res, body.model, delivery);
      return;
    }
    const chat = /AUTOMATION_CHAT_[A-Z_]+/.exec(text)?.[0];
    if (chat !== undefined && text.includes('<channel ')) chats.push(chat);
    stream(res, body.model, chat ?? 'Fixture notification acknowledged.');
  }

  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => { chunks.push(chunk); });
    req.on('end', () => {
      try {
        requests++;
        if (req.url?.includes('/messages') === true) assert.equal(req.headers['x-api-key'], 'fixture-key', 'only a fake API key reaches the local fixture');
        assert.equal(req.headers.authorization, undefined, 'no inherited provider authorization');
        if (req.url?.includes('count_tokens')) {
          res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ input_tokens: 50 }));
          return;
        }
        answer(JSON.parse(Buffer.concat(chunks).toString() || '{}') as Request, res);
      } catch (err) {
        errors.push(String(err));
        res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: String(err) } }));
      }
    });
  });
  const port = 10_000 + Math.floor(Math.random() * 20_000);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return {
    base: `http://127.0.0.1:${String(port)}`, scheduled, workers, chats, acknowledgments, errors, held, bashCommands, bashResults,
    get requests() { return requests; },
    expect(request: AutomationRequest, outcome: AutomationOutcome = 'completed', holdFinish = false, bash = false): void {
      expected.set(request.uuid, { request, outcome, bash });
      if (holdFinish) hold.add(request.uuid);
    },
    release(uuid: string): void {
      const entry = held.get(uuid);
      assert.ok(entry && !entry.res.destroyed, 'release only the fixture worker waiting before its receipt');
      hold.delete(uuid);
      held.delete(uuid);
      finish(entry.res, entry.model, uuid);
    },
    close(): void { server.closeAllConnections(); server.close(); },
  };
}
