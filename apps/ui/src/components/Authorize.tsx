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
import { mintCollectionCode, type Collection } from '../api/collections';
import { rememberedProject, type Project } from '../api/projects';
import {
  queryError,
  useCollectionsQuery,
  useProjectsQuery,
} from '../api/queries';
import { useDocumentTitle } from '../title';

const CARD_WIDTH = 460;
const EMPTY = 'This project has no collections yet.';

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
          <PageTitle>Authorize a machine</PageTitle>
        </Row>
        {children}
      </Col>
    </Row>
  );
}

function Choice({
  name,
  detail,
  busy,
  label,
  onPick,
}: {
  name: string;
  detail: string;
  busy: boolean;
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
        disabled={busy}
        label={label}
        onPress={onPick}
      />
    </Row>
  );
}

function CollectionChoices({
  token,
  project,
  onMinted,
}: {
  token: string;
  project: string;
  onMinted: (code: string, name: string) => void;
}): ReactNode {
  const { data, error } = useCollectionsQuery(token, project);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  const pick = (collection: Collection): void => {
    if (busy) return;
    setBusy(true);
    setFailed(null);
    mintCollectionCode(token, collection.id)
      .then((minted) => {
        onMinted(minted.code, minted.collection);
      })
      .catch((err: unknown) => {
        setFailed(queryError(err, 'Could not create a code.'));
      })
      .finally(() => {
        setBusy(false);
      });
  };

  const rows = data ?? [];
  return (
    <Col>
      {failed === null ? null : (
        <Text size="sm" role="danger">
          {failed}
        </Text>
      )}
      {error === null ? null : (
        <Text size="sm" role="danger">
          {queryError(error, 'Could not load the collections.')}
        </Text>
      )}
      {data === undefined && error === null ? <Loading /> : null}
      {data !== undefined && rows.length === 0 ? (
        <Text size="sm" role="secondary">
          {EMPTY}
        </Text>
      ) : null}
      {rows.map((collection) => (
        <Choice
          key={collection.id}
          name={collection.name}
          detail={`${String(collection.connectorIds.length)} connector${collection.connectorIds.length === 1 ? '' : 's'}`}
          busy={busy}
          label="Authorize"
          onPick={() => {
            pick(collection);
          }}
        />
      ))}
    </Col>
  );
}

function Minted({
  code,
  name,
  onAgain,
}: {
  code: string;
  name: string;
  onAgain: () => void;
}): ReactNode {
  const dark = useKitScheme() === 'dark';
  return (
    <Col gap={16}>
      <Col gap={4}>
        <CopyBlock label={`Code for '${name}'`} value={code} />
        <Text size="sm" role="secondary">
          Paste this into the terminal waiting on metro login.
        </Text>
      </Col>
      <Button
        block
        size="md"
        color="secondary"
        dark={dark}
        label="Authorize another"
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
          busy={false}
          label="Choose"
          onPick={() => {
            onPick(project);
          }}
        />
      ))}
    </Col>
  );
}

export function Authorize({ token }: { token: string }): ReactNode {
  const { data, error } = useProjectsQuery(token);
  const [picked, setPicked] = useState<string | null>(null);
  const [choosing, setChoosing] = useState(false);
  const [code, setCode] = useState<{ value: string; name: string } | null>(null);
  useDocumentTitle('Authorize a machine');

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
  if (code !== null)
    return (
      <Card>
        <Minted
          code={code.value}
          name={code.name}
          onAgain={() => {
            setCode(null);
          }}
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
        <CollectionChoices
          token={token}
          project={current.id}
          onMinted={(value, name) => {
            setCode({ value, name });
          }}
        />
      </Col>
    </Card>
  );
}
