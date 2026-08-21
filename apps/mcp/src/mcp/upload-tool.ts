import { publicBaseOrDefault } from '../daemon/attach-serve.js';
import { safeFileName } from '../stations/attach-inline.js';
import { guessMime } from '../stations/attachments.js';
import {
  createUploadSlot,
  issueUploadTicket,
  MAX_UPLOAD_BYTES,
  removeUpload,
  UPLOAD_TTL_MS,
} from '../daemon/upload-store.js';
import type { ToolResult } from '../stations/types.js';
import { errResult, okJson } from './ctx.js';
import { allowedAgents, currentIdentity } from './request-identity.js';
import { str } from './str.js';

const ttlMinutes = (): number => Math.round(UPLOAD_TTL_MS / 60_000);

const NO_AGENT =
  'create_upload needs an agent credential; this session is not scoped to one agent';

const manyAgents = (n: number): string =>
  `create_upload is scoped to one agent, but this session covers ${String(n)}` +
  ' (a multi-agent sign-in); use `POST /api/uploads?agent=<id>` directly instead';

type OwnerAgent = { agentId: string } | { error: string };

function ownerAgent(): OwnerAgent {
  const allowed = allowedAgents(currentIdentity());
  const [only] = [...allowed];
  if (allowed.size === 1 && only !== undefined) return { agentId: only };
  return { error: allowed.size === 0 ? NO_AGENT : manyAgents(allowed.size) };
}

export function dispatchCreateUpload(
  a: Record<string, unknown>,
): Promise<ToolResult> {
  const owner = ownerAgent();
  if ('error' in owner) return Promise.resolve(errResult(owner.error));
  const agentId = owner.agentId;
  const name = safeFileName(str(a.name) || undefined);
  const mime = str(a.mime) || guessMime(name);
  const id = createUploadSlot(agentId, { name, mime });
  const token = issueUploadTicket(id, agentId);
  if (token === undefined) {
    removeUpload(id);
    return Promise.resolve(errResult('metro could not reserve an upload slot'));
  }
  const url = `${publicBaseOrDefault()}/api/uploads/${id}?token=${token}`;
  return Promise.resolve(
    okJson({
      upload_id: id,
      upload_url: url,
      curl: `curl -sS -T '<the file on your own machine>' '${url}'`,
      name,
      mime,
      max_bytes: MAX_UPLOAD_BYTES,
      expires_in_minutes: ttlMinutes(),
      next:
        'Run that command in a shell, then attach the file with ' +
        `send({line, attachments:[{upload:'${id}'}]}). The url is single-use, is good ` +
        `only for this one file, and expires in ${ttlMinutes()} minutes. If you have no ` +
        'shell, delegate the one command to a subagent that does and keep the upload_id; ' +
        'the slot belongs to this metro agent, not to whoever runs the command.',
    }),
  );
}
