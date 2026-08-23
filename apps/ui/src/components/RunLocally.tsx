import { type ReactNode, useState } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Text, Button } from './ui';
import { CopyBlock } from './CopyBlock';
import { mintRuntimeCode, releaseRuntime, type AgentSummary } from '../api/client';
import { queryError } from '../api/queries';

interface RunLocallyProps {
  token: string;
  agent: AgentSummary;
  onChanged: () => void;
}

export function RunLocally({
  token,
  agent,
  onChanged,
}: RunLocallyProps): ReactNode {
  const dark = useKitScheme() === 'dark';
  const [code, setCode] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  if (!agent.owned) return null;

  const run = (work: Promise<unknown>, fallback: string): void => {
    if (busy) return;
    setBusy(true);
    setFailed(null);
    work
      .then((value) => {
        if (typeof value === 'string') setCode(value);
        onChanged();
      })
      .catch((err: unknown) => {
        setFailed(queryError(err, fallback));
      })
      .finally(() => {
        setBusy(false);
      });
  };

  if (agent.runtime !== null)
    return (
      <Col gap={10}>
        <Text size="lg" weight="semibold">
          Running on {agent.runtime}
        </Text>
        <Text size="sm" role="secondary">
          This agent&apos;s stations run on that machine, so its messages do not
          pass through Metro. Metro serves it nothing while it is held.
        </Text>
        {failed === null ? null : (
          <Text size="sm" role="danger">
            {failed}
          </Text>
        )}
        <Row>
          <Button
            size="md"
            color="secondary"
            dark={dark}
            loading={busy}
            label="Take it back"
            onPress={() => {
              setCode(null);
              run(
                releaseRuntime(token, agent.id),
                'Could not release that machine.',
              );
            }}
          />
        </Row>
      </Col>
    );

  return (
    <Col gap={10}>
      <Text size="lg" weight="semibold">
        Run on your own machine
      </Text>
      <Text size="sm" role="secondary">
        Run this agent&apos;s stations yourself so its messages never pass
        through Metro. Start it with the command below, then paste this code.
      </Text>
      <CopyBlock label="on your machine" value={`metro start ${agent.id}`} />
      {code === null ? null : (
        <CopyBlock label="pairing code" value={code} secret hide={code} />
      )}
      <Text size="sm" role="secondary">
        metro start prints this page&apos;s address, so you can authorize from
        the machine&apos;s own terminal instead.
      </Text>
      {failed === null ? null : (
        <Text size="sm" role="danger">
          {failed}
        </Text>
      )}
      <Row>
        <Button
          size="md"
          color="primary"
          dark={dark}
          loading={busy}
          label={code === null ? 'Authorize a machine' : 'New code'}
          onPress={() => {
            run(
              mintRuntimeCode(token, agent.id),
              'Could not create a pairing code.',
            );
          }}
        />
      </Row>
    </Col>
  );
}
