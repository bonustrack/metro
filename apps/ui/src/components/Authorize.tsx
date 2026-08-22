import { type ReactNode, useState } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitPalette, useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Text, Button } from './ui';
import { SHRINK } from '../theme';
import { PageTitle } from './PageTitle';
import { CopyBlock } from './CopyBlock';
import { Loading } from './Loading';
import { mintCollectionCode, type Collection } from '../api/collections';
import { queryError, useCollectionsQuery } from '../api/queries';
import { useDocumentTitle } from '../title';

const BLURB =
  'Pick the collection this machine may read, then paste the code back into metro login. The code lasts ten minutes and works once.';

const EMPTY =
  'You have no collections yet. Make one on the Collections page, then come back.';

function CollectionChoice({
  list,
  busy,
  onPick,
}: {
  list: Collection;
  busy: boolean;
  onPick: () => void;
}): ReactNode {
  const palette = useKitPalette();
  const dark = useKitScheme() === 'dark';
  const count = list.connectorIds.length;
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
          {list.name}
        </Text>
        <Text size="sm" role="secondary" numberOfLines={1} style={SHRINK}>
          {`${String(count)} connector${count === 1 ? '' : 's'}`}
        </Text>
      </Row>
      <Button
        size="md"
        color="primary"
        dark={dark}
        disabled={busy}
        label="Authorize"
        onPress={onPick}
      />
    </Row>
  );
}

export function Authorize({ token }: { token: string }): ReactNode {
  const { data, error } = useCollectionsQuery(token);
  const [code, setCode] = useState<string | null>(null);
  const [picked, setPicked] = useState('');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  useDocumentTitle('Authorize a machine');

  const pick = (list: Collection): void => {
    if (busy) return;
    setBusy(true);
    setFailed(null);
    mintCollectionCode(token, list.id)
      .then((minted) => {
        setCode(minted.code);
        setPicked(minted.list);
      })
      .catch((err: unknown) => {
        setFailed(queryError(err, 'Could not create a code.'));
      })
      .finally(() => {
        setBusy(false);
      });
  };

  return (
    <Col gap={20}>
      <Col gap={8}>
        <PageTitle>Authorize a machine</PageTitle>
        <Text size="sm" role="secondary">
          {BLURB}
        </Text>
      </Col>
      {failed === null ? null : <Text size="sm" role="danger">{failed}</Text>}
      {code === null ? null : (
        <Col gap={4}>
          <CopyBlock label={`Code for '${picked}'`} value={code} />
          <Text size="sm" role="secondary">
            Paste this into the terminal waiting on metro login.
          </Text>
        </Col>
      )}
      {error === null ? null : (
        <Text size="sm" role="danger">
          {queryError(error, 'Could not load your collections.')}
        </Text>
      )}
      {data === undefined && error === null ? <Loading /> : null}
      {data?.length === 0 ? (
        <Text size="sm" role="secondary">
          {EMPTY}
        </Text>
      ) : null}
      <Col>
        {(data ?? []).map((list) => (
          <CollectionChoice
            key={list.id}
            list={list}
            busy={busy}
            onPick={() => {
              pick(list);
            }}
          />
        ))}
      </Col>
    </Col>
  );
}
