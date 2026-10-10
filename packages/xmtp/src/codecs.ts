import type {
  ContentTypeId,
  ContentCodec,
  EncodedContent,
} from '@xmtp/content-type-primitives';

const enc = (o: unknown): Uint8Array =>
  new TextEncoder().encode(JSON.stringify(o));
const dec = (e: EncodedContent): unknown =>
  JSON.parse(new TextDecoder().decode(e.content));

const makeJsonCodec = <T>(
  contentType: ContentTypeId,
  fallbackFn: (c: T) => string | undefined,
  push = true,
) =>
  class {
    get contentType() {
      return contentType;
    }
    encode(c: T): EncodedContent {
      const fallback = fallbackFn(c);
      return {
        type: contentType,
        parameters: {},
        ...(fallback === undefined ? {} : { fallback }),
        content: enc(c),
      };
    }
    decode(e: EncodedContent): T {
      return dec(e) as T;
    }
    fallback(c: T) {
      return fallbackFn(c);
    }
    shouldPush() {
      return push;
    }
  };

export const ContentTypePoll: ContentTypeId = {
  authorityId: 'metro.box',
  typeId: 'poll',
  versionMajor: 1,
  versionMinor: 0,
};
export interface PollOption {
  label: string;
  description?: string;
}
export interface PollQuestion {
  question: string;
  header?: string;
  multiSelect?: boolean;
  open?: boolean;
  options?: (PollOption | string)[];
}
export interface PollContent {
  questions?: PollQuestion[];
  question?: string;
  header?: string;
  multiSelect?: boolean;
  pollId?: string;
  options?: (PollOption | string)[];
  [k: string]: unknown;
}
const pollTitle = (c: PollContent): string =>
  c.questions?.[0]?.question ?? c.question ?? 'Poll';
export const PollCodec = makeJsonCodec<PollContent>(
  ContentTypePoll,
  (c) => `📊 Poll: ${pollTitle(c)}`,
);

const normOpts = (o: (string | PollOption)[]): PollOption[] =>
  o.map((x) =>
    typeof x === 'string'
      ? { label: x }
      : { label: x.label, description: x.description },
  );

export function buildPollContent(
  args: Record<string, unknown>,
  pollId: string,
): { poll: PollContent; title: string } {
  const { question, options, header, multiSelect, questions } = args as {
    question?: string;
    options?: (string | PollOption)[];
    header?: string;
    multiSelect?: boolean;
    questions?: PollQuestion[];
  };
  if (Array.isArray(questions) && questions.length > 0) {
    const norm: PollQuestion[] = questions.map((q, i) => {
      if (!q || typeof q.question !== 'string' || !q.question)
        throw new Error(`ask questions[${i}] requires a question`);
      const open = q.open === true;
      const opts = Array.isArray(q.options) ? q.options : [];
      if (!open && opts.length === 0)
        throw new Error(
          `ask questions[${i}] requires a non-empty options array (or open:true for free-text)`,
        );
      return {
        question: q.question,
        options: normOpts(opts),
        multiSelect: !!q.multiSelect,
        ...(open ? { open: true } : {}),
        ...(q.header ? { header: q.header } : {}),
      };
    });
    const first = norm[0];
    if (!first) throw new Error('ask requires at least one question');
    return { poll: { questions: norm, pollId }, title: first.question };
  }
  if (!question || typeof question !== 'string')
    throw new Error('ask requires a question (or a questions[] array)');
  if (!Array.isArray(options) || options.length === 0)
    throw new Error('ask requires a non-empty options array');
  return {
    poll: {
      question,
      options: normOpts(options),
      multiSelect: !!multiSelect,
      pollId,
      ...(header ? { header } : {}),
    },
    title: question,
  };
}

export const ContentTypeSignatureRequest: ContentTypeId = {
  authorityId: 'metro.box',
  typeId: 'signatureRequest',
  versionMajor: 1,
  versionMinor: 0,
};
export interface SignatureRequestContent {
  id?: string;
  kind?: 'eip712' | 'personal';
  eip712?: unknown;
  message?: string;
  description?: string;
  [k: string]: unknown;
}
export const SignatureRequestCodec = makeJsonCodec<SignatureRequestContent>(
  ContentTypeSignatureRequest,
  (c) =>
    c.description
      ? `[Signature request] ${c.description}`
      : '[Signature request]',
);

export const ContentTypeSignatureReference: ContentTypeId = {
  authorityId: 'metro.box',
  typeId: 'signatureReference',
  versionMajor: 1,
  versionMinor: 0,
};
export interface SignatureReferenceContent {
  requestId?: string;
  signature: string;
  signer?: string;
  [k: string]: unknown;
}
export const SignatureReferenceCodec =
  makeJsonCodec<SignatureReferenceContent>(ContentTypeSignatureReference, (c) =>
    c.signature ? `[Signature] ${c.signature}` : '[Signature]',
  );

const xmtpOrg = (typeId: string): ContentTypeId => ({
  authorityId: 'xmtp.org',
  typeId,
  versionMajor: 1,
  versionMinor: 0,
});
export const WalletSendCallsCodec = makeJsonCodec<{ calls?: { metadata?: { description?: string } }[] }>(
  xmtpOrg('walletSendCalls'),
  (c) => {
    const desc = c.calls?.[0]?.metadata?.description;
    return desc ? `[Transaction request] ${desc}` : '[Transaction request]';
  },
);
export const TransactionReferenceCodec = makeJsonCodec<{ reference?: string }>(
  xmtpOrg('transactionReference'),
  (c) => (c.reference ? `[Transaction] ${c.reference}` : '[Transaction]'),
);

export const ContentTypeFrame: ContentTypeId = {
  authorityId: 'stage.box',
  typeId: 'frame',
  versionMajor: 1,
  versionMinor: 0,
};
export interface FrameContent {
  title?: string;
  description?: string;
  widget?: Record<string, unknown>;
  screens?: Record<string, unknown>;
  start?: string;
  source?: { url: string };
}
export const frameFallback = (c: FrameContent): string => {
  const head = c.title ? `Frame: ${c.title}` : 'Frame';
  return c.description ? `${head}\n${c.description}` : head;
};
export const FrameCodec = makeJsonCodec<FrameContent>(ContentTypeFrame, frameFallback);

export const ContentTypeFrameAction: ContentTypeId = {
  authorityId: 'stage.box',
  typeId: 'frameAction',
  versionMajor: 1,
  versionMinor: 0,
};
export interface FrameActionContent {
  frameId: string;
  action: { type: string; payload?: Record<string, unknown> };
  label?: string;
}
export const frameActionText = (c: FrameActionContent): string => {
  const payload = c.action.payload === undefined ? '' : ` ${JSON.stringify(c.action.payload)}`;
  return `Frame action: ${c.action.type}${payload}`;
};
const FrameActionCodec = makeJsonCodec<FrameActionContent>(ContentTypeFrameAction, frameActionText);

export const ContentTypeDeleteRequest: ContentTypeId = {
  authorityId: 'stage.box',
  typeId: 'deleteRequest',
  versionMajor: 1,
  versionMinor: 0,
};
const DeleteRequestCodec = makeJsonCodec<{ messageId: string }>(ContentTypeDeleteRequest, () => 'Message deleted');

const ContentTypeDeleteMessage: ContentTypeId = {
  authorityId: 'xmtp.org',
  typeId: 'deleteMessage',
  versionMajor: 1,
  versionMinor: 0,
};

const varint = (value: number): number[] => {
  const out: number[] = [];
  let rest = value;
  while (rest > 0x7f) {
    out.push((rest & 0x7f) | 0x80);
    rest = Math.floor(rest / 0x80);
  }
  out.push(rest);
  return out;
};

export function encodeDeleteMessage(messageId: string): EncodedContent {
  const id = new TextEncoder().encode(messageId);
  return {
    type: ContentTypeDeleteMessage,
    parameters: {},
    content: new Uint8Array([0x0a, ...varint(id.length), ...id]),
  };
}

export const CALL_TYPES = new Set(['callInvite', 'callSignal']);
const callContentType = (typeId: string): ContentTypeId => ({
  authorityId: 'stage.box',
  typeId,
  versionMajor: 1,
  versionMinor: 0,
});
const CallInviteCodec = makeJsonCodec<{ video?: unknown }>(callContentType('callInvite'), (c) =>
  c.video === true ? '📞 Video call' : '📞 Voice call',
);
export const isCallSignal = (m: { contentType?: ContentTypeId }): boolean =>
  m.contentType?.authorityId === 'stage.box' && m.contentType.typeId === 'callSignal';
export const CallSignalCodec = makeJsonCodec<Record<string, unknown>>(callContentType('callSignal'), () => undefined, false);

export const CODECS = (): ContentCodec[] => [
  new PollCodec(),
  new SignatureRequestCodec(),
  new SignatureReferenceCodec(),
  new FrameCodec(),
  new FrameActionCodec(),
  new DeleteRequestCodec(),
  new CallInviteCodec(),
  new CallSignalCodec(),
];
