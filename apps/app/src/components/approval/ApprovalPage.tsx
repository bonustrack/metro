import { type ReactNode, useState } from 'react';
import { Column } from '@stage-labs/kit/react-native/column';
import { Row } from '@stage-labs/kit/react-native/row';
import { Button } from '@stage-labs/kit/react-native/button';
import { Text } from '@stage-labs/kit/react-native/text';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { approvalCard, type ApprovalCard } from '@metro-labs/client/api/approval-card';
import type { Approval, Decision } from '@metro-labs/client/api/approvals';
import { Icon } from '../Icon.js';
import { ErrorState } from '../ui/ErrorState.js';
import { Group } from '../ui/Group.js';
import { Item } from '../ui/Item.js';
import { LogBlock } from '../ui/LogBlock.js';
import { RowsSkeleton, SkeletonBlock } from '../ui/RowsSkeleton.js';
import { StateBlock } from '../ui/StateBlock.js';
import { side } from '../ui/edges.js';
import { ICON_SIZE } from '../ui/sizes.js';
import { ApprovalFrame, useApprovalAgent } from './ApprovalFrame.js';
import { useApprovalTitle } from '../../lib/approval-connector.js';
import type { NamedConnector } from '../../lib/approval-note.js';
import { ANSWER_IDLE, approvalPageState, DECIDE_FAILED, GONE_WORDS, resultWords, runAnswer, type AnswerState, type Answering, type ApprovalRead } from '../../lib/approval-page.js';
import { logError } from '../../lib/log.js';
import { go } from '../../lib/nav.js';
import { queryError } from '../../lib/queries.js';
import { useTechnicalDetails } from '../../lib/technical.js';
import { useDocumentTitle } from '../../lib/title.js';
import { timeOf } from '../../lib/when-words.js';

const TITLE_SKELETON = { width: 220, height: 28 } as const;

export interface ApprovalShown {
  approval: Approval;
  where: string | null | undefined;
  connector: NamedConnector | null | undefined;
  mark: ReactNode;
}

export interface ApprovalSource<T> {
  read: ApprovalRead<T>;
  retry: () => unknown;
  pick: (items: T[]) => T | undefined;
  show: (item: T) => ApprovalShown;
  send: (decision: Decision) => Promise<void>;
  refresh: () => Promise<void>;
}

interface Answers<T> {
  answering: Answering<T>;
  busy: Decision | null;
  error: string | null;
  answer: (item: T, decision: Decision) => void;
}

function useAnswers<T>(send: (decision: Decision) => Promise<void>, refresh: () => Promise<void>): Answers<T> {
  const [state, setState] = useState<AnswerState<T>>(ANSWER_IDLE);
  const update = (patch: Partial<AnswerState<T>>): void => {
    setState((prev) => ({ ...prev, ...patch }));
  };
  const answer = (item: T, decision: Decision): void => {
    if (state.busy !== null || state.outcome !== null) return;
    runAnswer(item, decision, { send, refresh, update, errorText: (err) => queryError(err, DECIDE_FAILED) }).catch(logError('approval.answer'));
  };
  return { answering: { held: state.held, outcome: state.outcome }, busy: state.busy, error: state.error, answer };
}

function placeLabel(card: ApprovalCard): string {
  if (card.connector !== null) return 'Connector';
  return card.station === null ? 'Where' : 'Channel';
}

function Place({ shown, card }: { shown: ApprovalShown; card: ApprovalCard }): ReactNode {
  if (shown.where === undefined) return <RowsSkeleton rows={1} trailing={false} />;
  if (shown.where === null) return null;
  return <Item title={shown.where} subtitle={placeLabel(card)} leading={shown.mark} />;
}

function Title({ text }: { text: string | undefined }): ReactNode {
  if (text === undefined) return <SkeletonBlock width={TITLE_SKELETON.width} height={TITLE_SKELETON.height} />;
  return (
    <Text accessibilityRole="header" size="2xl" fontWeight="semibold">
      {text}
    </Text>
  );
}

function Facts({ shown, card }: { shown: ApprovalShown; card: ApprovalCard }): ReactNode {
  const palette = useKitPalette();
  const technical = useTechnicalDetails();
  const asked = shown.approval.requestedAt;
  const by = shown.approval.requestedBy;
  return (
    <Group>
      <Place shown={shown} card={card} />
      {asked === '' ? null : <Item title={timeOf(asked, technical)} subtitle="Asked" leading={<Icon name="clock" size={ICON_SIZE.lg} color={palette.text} />} />}
      {by === null ? null : <Item title={by} subtitle="Asked by" leading={<Icon name="key" size={ICON_SIZE.lg} color={palette.text} />} />}
      {technical ? <Item title={shown.approval.name} subtitle="Tool" leading={<Icon name="processor" size={ICON_SIZE.lg} color={palette.text} />} /> : null}
    </Group>
  );
}

function Field({ label, value }: { label: string; value: string }): ReactNode {
  const palette = useKitPalette();
  return (
    <Column gap={4} padding={{ y: 14 }} border={{ bottom: side(palette.border) }}>
      <Text size="xs" color="secondary">
        {label}
      </Text>
      <Text size="md" color={palette.text} selectable>
        {value}
      </Text>
    </Column>
  );
}

function Quiet({ text }: { text: string }): ReactNode {
  return (
    <Column padding={{ y: 14 }}>
      <Text size="md" color="secondary">
        {text}
      </Text>
    </Column>
  );
}

function Details({ approval, card }: { approval: Approval; card: ApprovalCard }): ReactNode {
  const technical = useTechnicalDetails();
  const raw = approval.request.trim();
  if (card.everything.length === 0)
    return (
      <Group label="Details">
        {raw === '' || raw === '{}' ? <Quiet text="No details came with this request." /> : <LogBlock text={approval.request} maxHeight={null} />}
      </Group>
    );
  return (
    <>
      <Group label="Everything in this call">
        {card.everything.map((field, index) => (
          <Field key={`${String(index)}:${field.label}`} label={field.label} value={field.value} />
        ))}
      </Group>
      {technical && raw !== '' ? (
        <Group label="As Metro received it">
          <LogBlock text={approval.request} maxHeight={null} />
        </Group>
      ) : null}
    </>
  );
}

function Buttons<T>({ item, answers }: { item: T; answers: Answers<T> }): ReactNode {
  const { busy, error, answer } = answers;
  return (
    <Column gap={10}>
      <Row gap={12}>
        <Column weight={1}>
          <Button size="lg" color="secondary" fullWidth disabled={busy !== null} loading={busy === 'deny'} label="Deny" onPress={() => { answer(item, 'deny'); }} />
        </Column>
        <Column weight={1}>
          <Button size="lg" color="primary" fullWidth disabled={busy !== null} loading={busy === 'allow'} label="Approve" onPress={() => { answer(item, 'allow'); }} />
        </Column>
      </Row>
      {error === null ? null : <Text size="md" color="danger">{error}</Text>}
    </Column>
  );
}

function backHome({ project, name }: { project: string; name: string }): { label: string; onPress: () => void } {
  return { label: `Back to ${name}`, onPress: () => { go({ kind: 'home', project }); } };
}

function Result({ project, decision }: { project: string; decision: Decision }): ReactNode {
  const { name } = useApprovalAgent();
  const words = resultWords(decision, name);
  return <StateBlock icon={decision === 'allow' ? 'checkCircle' : 'ban'} title={words.title} text={words.text} action={backHome({ project, name })} />;
}

function Gone({ project }: { project: string }): ReactNode {
  const { name } = useApprovalAgent();
  return <StateBlock icon="clock" title={GONE_WORDS.title} text={GONE_WORDS.text} action={backHome({ project, name })} />;
}

interface ShownPageProps<T> {
  project: string;
  item: T;
  shown: ApprovalShown;
  decision: Decision | null;
  answers: Answers<T>;
}

function ShownPage<T>({ project, item, shown, decision, answers }: ShownPageProps<T>): ReactNode {
  const card = approvalCard(shown.approval);
  const title = useApprovalTitle(card, shown.connector);
  return (
    <ApprovalFrame project={project}>
      <Column gap={8}>
        <Title text={title} />
        <Facts shown={shown} card={card} />
      </Column>
      <Details approval={shown.approval} card={card} />
      {decision === null ? <Buttons item={item} answers={answers} /> : <Result project={project} decision={decision} />}
    </ApprovalFrame>
  );
}

function PageSkeleton(): ReactNode {
  return (
    <Column gap={8}>
      <SkeletonBlock width={TITLE_SKELETON.width} height={TITLE_SKELETON.height} />
      <RowsSkeleton rows={3} trailing={false} />
    </Column>
  );
}

export function ApprovalScreen<T>({ project, source }: { project: string; source: ApprovalSource<T> }): ReactNode {
  useDocumentTitle(`Approval - ${useApprovalAgent().name}`);
  const answers = useAnswers<T>(source.send, source.refresh);
  const state = approvalPageState(source.read, source.pick, answers.answering);
  if (state.kind === 'waiting') return <ShownPage project={project} item={state.item} shown={source.show(state.item)} decision={null} answers={answers} />;
  if (state.kind === 'answered') return <ShownPage project={project} item={state.item} shown={source.show(state.item)} decision={state.decision} answers={answers} />;
  return (
    <ApprovalFrame project={project}>
      {state.kind === 'loading' ? <PageSkeleton /> : null}
      {state.kind === 'failed' ? <ErrorState title="Could not load this request" text={queryError(source.read.error, 'Metro did not answer.')} onRetry={source.retry} /> : null}
      {state.kind === 'gone' ? <Gone project={project} /> : null}
    </ApprovalFrame>
  );
}
