import { type ReactNode, useState } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import {
  useKitPalette,
  useKitScheme,
} from '@stage-labs/kit/react-native/theme-context';
import { BLOCK_RADIUS_DEFAULT } from '@stage-labs/kit/tokens';
import { Text, Button } from './ui';
import { SHRINK } from '../theme';
import { MetroLogo } from './MetroLogo';
import { PageTitle } from './PageTitle';
import { CopyBlock } from './CopyBlock';
import { Loading } from './Loading';
import { mintAgentCode, type AgentCode } from '../api/agent-connectors';
import { type AgentSummary } from '../api/client';
import { rememberedProject, type Project } from '../api/projects';
import { queryError, useAgentsQuery, useProjectsQuery } from '../api/queries';
import { useDocumentTitle } from '../title';

const CARD_WIDTH = 460;
const TITLE = 'Authorize a machine';
const EMPTY = 'This project has no agents yet.';
const HOW =
  'Paste it into the terminal waiting on metro login or metro start. It works once and expires after ten minutes.';
const HOW_ONE =
  'Paste the code into the terminal waiting on metro start: that machine then runs the stations of this agent, so their messages never pass through Metro. The same code signs a machine in with metro login.';

function Card({ children }: { children: ReactNode }): ReactNode {
  const palette = useKitPalette();
  const side = { width: 1, color: palette.border };
  return (
    <Row justify="center" align="center" flex={1} padding={24}>
      <Col
        gap={24}
        width="100%"
        maxWidth={CARD_WIDTH}
        padding={24}
        radius={BLOCK_RADIUS_DEFAULT}
        border={{ top: side, right: side, bottom: side, left: side }}
      >
        <Row justify="center">
          <MetroLogo size={48} color={palette.link} />
        </Row>
        <Row justify="center">
          <PageTitle>{TITLE}</PageTitle>
        </Row>
        {children}
      </Col>
    </Row>
  );
}

function Choice({
  name,
  detail,
  disabled,
  label,
  onPick,
}: {
  name: string;
  detail: string;
  disabled: boolean;
  label: string;
  onPick: () => void;
}): ReactNode {
  const palette = useKitPalette();
  const dark = useKitScheme() === 'dark';
  return (
    <Row
      justify="between"
      align="center"
      gap={12}
      padding={{ y: 12 }}
      border={{ bottom: { width: 1, color: palette.border } }}
    >
      <Row gap={10} align="center" flex={1} minWidth={0}>
        <Text size="lg" weight="semibold" numberOfLines={1}>
          {name}
        </Text>
        <Text size="sm" role="secondary" numberOfLines={1} style={SHRINK}>
          {detail}
        </Text>
      </Row>
      <Button
        size="md"
        color="primary"
        dark={dark}
        disabled={disabled}
        label={label}
        onPress={onPick}
      />
    </Row>
  );
}

interface Minting {
  busy: boolean;
  failed: string | null;
  code: AgentCode | null;
  mint: (agentId: string) => void;
  reset: () => void;
}

function useMint(token: string): Minting {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [code, setCode] = useState<AgentCode | null>(null);
  const mint = (agentId: string): void => {
    if (busy) return;
    setBusy(true);
    setFailed(null);
    mintAgentCode(token, agentId)
      .then(setCode)
      .catch((err: unknown) => {
        setFailed(queryError(err, 'Could not create a pairing code.'));
      })
      .finally(() => {
        setBusy(false);
      });
  };
  const reset = (): void => {
    setCode(null);
  };
  return { busy, failed, code, mint, reset };
}

function agentDetail(agent: AgentSummary): string {
  const n = agent.connectorIds.length;
  const connectors = `${String(n)} connector${n === 1 ? '' : 's'}`;
  return agent.owned ? connectors : `${connectors} · not owned`;
}

function AgentChoices({
  token,
  project,
  minting,
}: {
  token: string;
  project: string;
  minting: Minting;
}): ReactNode {
  const { data, error } = useAgentsQuery(token, project);
  const rows = data?.agents ?? [];
  return (
    <Col>
      {minting.failed === null ? null : (
        <Text size="sm" role="danger">
          {minting.failed}
        </Text>
      )}
      {error === null ? null : (
        <Text size="sm" role="danger">
          {queryError(error, 'Could not load the agents.')}
        </Text>
      )}
      {data === undefined && error === null ? <Loading /> : null}
      {data !== undefined && rows.length === 0 ? (
        <Text size="sm" role="secondary">
          {EMPTY}
        </Text>
      ) : null}
      {rows.map((agent) => (
        <Choice
          key={agent.id}
          name={agent.name}
          detail={agentDetail(agent)}
          disabled={minting.busy || !agent.owned}
          label="Authorize"
          onPick={() => {
            minting.mint(agent.id);
          }}
        />
      ))}
    </Col>
  );
}

function Minted({
  code,
  again,
  onAgain,
}: {
  code: AgentCode;
  again: string;
  onAgain: () => void;
}): ReactNode {
  const dark = useKitScheme() === 'dark';
  return (
    <Col gap={16}>
      <Col gap={4}>
        <CopyBlock
          label={`Code for '${code.agent}'`}
          value={code.code}
          secret
          hide={code.code}
        />
        <Text size="sm" role="secondary">
          {HOW}
        </Text>
      </Col>
      <Button
        block
        size="md"
        color="secondary"
        dark={dark}
        label={again}
        onPress={onAgain}
      />
    </Col>
  );
}

function Picker({
  projects,
  onPick,
}: {
  projects: Project[];
  onPick: (project: Project) => void;
}): ReactNode {
  return (
    <Col>
      <Text size="sm" role="secondary">
        Choose a project
      </Text>
      {projects.map((project) => (
        <Choice
          key={project.id}
          name={project.name}
          detail={project.isDefault ? 'default project' : project.role}
          disabled={false}
          label="Choose"
          onPick={() => {
            onPick(project);
          }}
        />
      ))}
    </Col>
  );
}

function AgentChooser({ token }: { token: string }): ReactNode {
  const { data, error } = useProjectsQuery(token);
  const [picked, setPicked] = useState<string | null>(null);
  const [choosing, setChoosing] = useState(false);
  const minting = useMint(token);

  const projects = data ?? [];
  const projectId = picked ?? rememberedProject(data);
  const current = projects.find((p) => p.id === projectId);

  if (error !== null)
    return (
      <Card>
        <Text size="sm" role="danger">
          {queryError(error, 'Could not load your projects.')}
        </Text>
      </Card>
    );
  if (data === undefined)
    return (
      <Card>
        <Loading />
      </Card>
    );
  if (minting.code !== null)
    return (
      <Card>
        <Minted
          code={minting.code}
          again="Authorize another"
          onAgain={minting.reset}
        />
      </Card>
    );
  if (choosing || current === undefined)
    return (
      <Card>
        <Picker
          projects={projects}
          onPick={(project) => {
            setPicked(project.id);
            setChoosing(false);
          }}
        />
      </Card>
    );
  return (
    <Card>
      <Col gap={10}>
        <Row justify="between" align="center" gap={10}>
          <Text weight="semibold" numberOfLines={1} style={SHRINK}>
            {current.name}
          </Text>
          <Button
            size="sm"
            color="secondary"
            label="Change project"
            onPress={() => {
              setChoosing(true);
            }}
          />
        </Row>
        <AgentChoices token={token} project={current.id} minting={minting} />
      </Col>
    </Card>
  );
}

function AgentAuthorize({
  token,
  id,
}: {
  token: string;
  id: string;
}): ReactNode {
  const dark = useKitScheme() === 'dark';
  const minting = useMint(token);
  const code = minting.code;
  return (
    <Card>
      <Col gap={14}>
        <Text size="sm" role="secondary">
          {HOW_ONE}
        </Text>
        <CopyBlock label="on your machine" value={`metro start ${id}`} />
        {code === null ? null : (
          <CopyBlock
            label={`pairing code for '${code.agent}'`}
            value={code.code}
            secret
            hide={code.code}
          />
        )}
        {minting.failed === null ? null : (
          <Text size="sm" role="danger">
            {minting.failed}
          </Text>
        )}
        <Button
          block
          size="md"
          color="primary"
          dark={dark}
          loading={minting.busy}
          label={code === null ? 'Authorize this machine' : 'New code'}
          onPress={() => {
            minting.mint(id);
          }}
        />
      </Col>
    </Card>
  );
}

export function Authorize({
  token,
  id,
}: {
  token: string;
  id: string | null;
}): ReactNode {
  useDocumentTitle(TITLE);
  if (id === null) return <AgentChooser token={token} />;
  return <AgentAuthorize token={token} id={id} />;
}
