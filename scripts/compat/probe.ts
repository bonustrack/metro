import { storeAccount } from '../../apps/ui/src/auth/account.ts';
import { setCurrentServer } from '../../apps/ui/src/auth/daemon.ts';
import * as attach from '../../apps/ui/src/api/attach.ts';
import * as session from '../../apps/ui/src/api/attach-session.ts';
import * as bundle from '../../apps/ui/src/api/bundle.ts';
import * as box from '../../apps/ui/src/api/claude-box.ts';
import * as claude from '../../apps/ui/src/api/claude.ts';
import * as client from '../../apps/ui/src/api/client.ts';
import * as conn from '../../apps/ui/src/api/connectors.ts';
import * as machine from '../../apps/ui/src/api/machine.ts';
import * as mode from '../../apps/ui/src/api/mode.ts';
import * as model from '../../apps/ui/src/api/model.ts';
import * as term from '../../apps/ui/src/api/terminal.ts';
import type { Section } from '../../apps/ui/src/export/pack.ts';
import * as transfer from '../../apps/ui/src/export/transfer.ts';
import * as agentUser from '../../apps/ui/src/api/agent-user.ts';

const need = (name: string): string => {
  const v = process.env[name];
  if (v === undefined || v === '') throw new Error(`${name} is not set`);
  return v;
};

const host = need('COMPAT_HOST');
const token = need('COMPAT_TOKEN');
const org = need('COMPAT_ORG');
const account = need('COMPAT_ACCOUNT');
const agent = need('COMPAT_AGENT');

storeAccount({
  accessToken: token,
  refreshToken: 'compat',
  organization: org,
  organizationName: null,
  organizationSlug: null,
  role: 'admin',
  user: { id: 'user_01ABC', email: null, name: null, picture: null },
});
setCurrentServer({ id: 'compat00001', host });

const mcp = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  async fetch(req) {
    if (req.method !== 'POST') return new Response(null, { status: 405 });
    const msg = (await req.json()) as { id?: number; method: string };
    if (msg.id === undefined) return new Response(null, { status: 202 });
    const result =
      msg.method === 'initialize'
        ? { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'compat', version: '1' } }
        : msg.method === 'tools/list'
          ? { tools: [{ name: 'hello', description: 'hi', inputSchema: { type: 'object' } }] }
          : {};
    return Response.json({ jsonrpc: '2.0', id: msg.id, result }, { headers: { 'mcp-session-id': 's1' } });
  },
});

let failed = 0;
const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

async function ok<T>(name: string, fn: () => Promise<T>): Promise<T | undefined> {
  try {
    const out = await fn();
    console.log(`ok   ${name}`);
    return out;
  } catch (err) {
    failed += 1;
    console.log(`FAIL ${name}: ${message(err)}`);
    return undefined;
  }
}

async function refused(name: string, want: RegExp, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
    failed += 1;
    console.log(`FAIL ${name}: succeeded, expected a refusal matching ${String(want)}`);
  } catch (err) {
    if (want.test(message(err))) console.log(`ok   ${name} (refused: ${message(err)})`);
    else {
      failed += 1;
      console.log(`FAIL ${name}: ${message(err)}`);
    }
  }
}

await ok('fetchMode', () => mode.fetchMode());
await ok('fetchSession', () => client.fetchSession());
await ok('fetchStations', async () => {
  const view = await client.fetchStations();
  if (view.agent?.id !== agent) throw new Error(`the agent list names ${view.agent?.id ?? 'no agent'}, not ${agent}`);
});
await ok('fetchMachine', () => machine.fetchMachine());
await ok('terminalStatus', () => term.terminalStatus());
await ok('mintTerminalTicket', () => term.mintTerminalTicket('metro'));

await ok('fetchClaudeSession', () => box.fetchClaudeSession());
await ok('controlClaudeSession autostart', () => box.controlClaudeSession({ autostart: false }));
await ok('fetchClaudeSetup', () => box.fetchClaudeSetup());
await ok('setClaudePrivacy', () => box.setClaudePrivacy(true));
await ok('setClaudePermissionMode', () => box.setClaudePermissionMode('auto'));
await ok('setClaudeSystemPrompt', () => box.setClaudeSystemPrompt('compat'));
await ok('setClaudeSystemPrompt clear', () => box.setClaudeSystemPrompt(''));
await ok('fetchClaudeVersion', () => box.fetchClaudeVersion());
await ok('fetchAgentUser', () => agentUser.fetchAgentUser());
await ok('fetchClaudeAccount', () => claude.fetchClaudeAccount());
const settings = await ok('fetchClaudeSettings', () => claude.fetchClaudeSettings());
const first = settings?.[0];
if (first !== undefined)
  await ok('saveClaudeSettings', () => claude.saveClaudeSettings(first.id, first.text === '' ? '{}' : first.text, first.modifiedAt));

await ok('fetchClaudeSkills', () => claude.fetchClaudeSkills());
const skill = await ok('createClaudeSkill', () => claude.createClaudeSkill('compat-skill'));
if (skill !== undefined) {
  await ok('fetchClaudeSkill', () => claude.fetchClaudeSkill(skill.id));
  await ok('saveClaudeSkill', () => claude.saveClaudeSkill(skill.id, '---\nname: compat-skill\ndescription: x\n---\nbody\n', null));
}

const project = '-compat';
const sid = '11111111-2222-3333-4444-555555555555';
const line = { type: 'user', cwd: '/compat', message: { role: 'user', content: 'hi' }, uuid: 'u1', timestamp: '2026-09-01T00:00:00Z' };
await ok('saveSessionFile', () => claude.saveSessionFile(project, sid, `${JSON.stringify(line)}\n`));
await ok('fetchClaudeProjects', () => claude.fetchClaudeProjects());
await ok('fetchClaudeSessions', () => claude.fetchClaudeSessions(project));
await ok('fetchTranscript', () => claude.fetchTranscript(project, sid, 0, 20));
await ok('fetchSessionFile', () => claude.fetchSessionFile(project, sid));
await ok('saveMemoryFile', () => claude.saveMemoryFile(project, 'compat.md', '# compat\n', '2026-09-01T00:00:00.000Z'));
await ok('fetchMemory', () => claude.fetchMemory(project));
await ok('fetchMemoryFile', () => claude.fetchMemoryFile(project, 'compat.md'));

await ok('fetchModel', () => model.fetchModel());
await ok('fetchModelBundle', () => model.fetchModelBundle());
const added = await ok('addConnection', () => model.addConnection({ provider: 'openrouter', apiKey: 'sk-or-compat', model: 'openai/gpt-5' }));
const cid = added?.connections[0]?.id ?? '';
await ok('saveConnection', () => model.saveConnection(cid, { label: 'Renamed' }));
await ok('chooseConnection', () => model.chooseConnection(cid));

const url = `http://127.0.0.1:${String(mcp.port)}/mcp`;
await ok('createConnector', () => conn.createConnector({ name: 'compat', url, header: '', value: '', clientId: '', clientSecret: '' }));
const listed = await ok('fetchConnectors', () => conn.fetchConnectors());
const connector = listed?.connectors[0]?.id ?? '';
await ok('fetchConnector', () => conn.fetchConnector(connector));
await ok('fetchConnectorTools', () => conn.fetchConnectorTools(connector));
await ok('verifyConnector', () => conn.verifyConnector(connector));
await ok('renameConnector', () => conn.renameConnector(connector, 'compat two'));
await refused('disconnectConnector', /not signed in/i, () => conn.disconnectConnector(connector));

await ok('setAllowlist', () => attach.setAllowlist(agent, 'threema', account, ['*ABCDEFG']));
await ok('setAccountEnabled off', () => attach.setAccountEnabled(agent, 'threema', account, false));
await ok('setAccountEnabled on', () => attach.setAccountEnabled(agent, 'threema', account, true));
await ok('fetchRecentSenders', () => attach.fetchRecentSenders(agent, 'threema', account));
await refused('lookupSender on threema', /resolve|look/i, () => attach.lookupSender(agent, 'threema', account, '+33600000000'));
await refused('accountName on threema', /name/i, () => attach.accountName(agent, 'threema', account));
await refused('startAttach webhook', /webhook|public/i, () => attach.startAttach(agent, 'webhook', {}));
await refused('pollAttachSession unknown', /not found|no such|unknown|expired/i, () =>
  session.pollAttachSession(agent, 'as_AAAAAAAAAAAAAAAAAAAAAA'),
);

await ok('fetchBundle', () => bundle.fetchBundle(agent));
await ok('restoreBundle', () => bundle.restoreBundle({ version: 1, mode: 'append', agent: { id: agent, name: '', stations: [] }, connectors: [] }));
await refused('restoreBundle foreign agent', /already|agent/i, () =>
  bundle.restoreBundle({ version: 1, mode: 'append', agent: { id: 'zzzzzzzzzzz', name: '', stations: [] }, connectors: [] }),
);
const everything = new Set<Section>(['channels', 'connectors', 'skills', 'memory', 'sessions', 'model']);
const gathered = await ok('gatherPayload', () => transfer.gatherPayload({ id: agent, name: '' }, everything, new Date().toISOString()));
if (gathered !== undefined)
  await ok('applyPayload', () => transfer.applyPayload(gathered.payload, everything, 'overwrite', { id: agent, name: '' }));

await ok('deleteConnector', () => conn.deleteConnector(connector));
await ok('dropConnection', () => model.dropConnection(cid));
if (skill !== undefined) await ok('deleteClaudeSkill', () => claude.deleteClaudeSkill(skill.id));
await ok('deleteMemoryFile', () => claude.deleteMemoryFile(project, 'compat.md'));
await ok('deleteClaudeSession', () => claude.deleteClaudeSession(project, sid));
await ok('detachAccount', () => attach.detachAccount(agent, 'threema', account));

await mcp.stop(true);
console.log(failed === 0 ? 'compat: every call passed' : `compat: ${String(failed)} call(s) failed`);
process.exit(failed === 0 ? 0 : 1);
