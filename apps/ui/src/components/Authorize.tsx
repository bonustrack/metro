import { type ReactNode, useState } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import {
  useKitPalette,
  useKitScheme,
} from '@stage-labs/kit/react-native/theme-context';
import { Text, Button } from './ui';
import { SHRINK } from '../theme';
import { PageTitle } from './PageTitle';
import { CopyBlock } from './CopyBlock';
import { Loading } from './Loading';
import { mintCollectionCode, type Collection } from '../api/collections';
import { type Project } from '../api/projects';
import {
  queryError,
  useCollectionsQuery,
  useProjectsQuery,
} from '../api/queries';
import { useDocumentTitle } from '../title';

const EMPTY = 'This project has no collections yet.';

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

export function Authorize({ token }: { token: string }): ReactNode {
  const { data, error } = useProjectsQuery(token);
  const [chosen, setChosen] = useState<Project | null>(null);
  const [code, setCode] = useState<{ value: string; name: string } | null>(null);
  useDocumentTitle('Authorize a machine');

  return (
    <Col gap={20}>
      <PageTitle>Authorize a machine</PageTitle>
      {code === null ? null : (
        <Col gap={4}>
          <CopyBlock label={`Code for '${code.name}'`} value={code.value} />
          <Text size="sm" role="secondary">
            Paste this into the terminal waiting on metro login.
          </Text>
        </Col>
      )}
      {error === null ? null : (
        <Text size="sm" role="danger">
          {queryError(error, 'Could not load your projects.')}
        </Text>
      )}
      {data === undefined && error === null ? <Loading /> : null}
      {chosen === null ? (
        <Col>
          {(data ?? []).map((project) => (
            <Choice
              key={project.id}
              name={project.name}
              detail={project.isDefault ? 'default project' : project.role}
              busy={false}
              label="Choose"
              onPick={() => {
                setChosen(project);
              }}
            />
          ))}
        </Col>
      ) : (
        <Col gap={10}>
          <Row gap={10} align="center">
            <Text weight="semibold">{chosen.name}</Text>
            <Button
              size="sm"
              color="secondary"
              label="Change project"
              onPress={() => {
                setChosen(null);
                setCode(null);
              }}
            />
          </Row>
          <CollectionChoices
            token={token}
            project={chosen.id}
            onMinted={(value, name) => {
              setCode({ value, name });
            }}
          />
        </Col>
      )}
    </Col>
  );
}
