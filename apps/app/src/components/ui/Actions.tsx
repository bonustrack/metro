import { type ReactNode } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { Button } from '@stage-labs/kit/react-native/button';
import { Text } from '@stage-labs/kit/react-native/text';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { useIsStacked } from '../../lib/media.js';
import { FULL_WIDTH } from '../../lib/style.js';

export interface MainAction {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  busy?: boolean;
  danger?: boolean;
}

export interface CancelAction {
  label?: string;
  onPress: () => void;
  disabled?: boolean;
}

interface ActionsProps {
  main?: MainAction;
  cancel?: CancelAction;
  note?: string;
  error?: string | null;
}

function MainButton({ main, stacked }: { main: MainAction; stacked: boolean }): ReactNode {
  const dark = useKitScheme() === 'dark';
  const busy = main.busy === true;
  return (
    <Button
      size={stacked ? 'lg' : 'md'}
      color={main.danger === true ? 'danger' : 'primary'}
      dark={dark}
      label={main.label}
      loading={busy}
      disabled={busy || main.disabled === true}
      onPress={main.onPress}
      style={stacked ? FULL_WIDTH : undefined}
    />
  );
}

function CancelButton({ cancel, stacked }: { cancel: CancelAction; stacked: boolean }): ReactNode {
  const dark = useKitScheme() === 'dark';
  return <Button size={stacked ? 'lg' : 'md'} color="secondary" dark={dark} label={cancel.label ?? 'Cancel'} disabled={cancel.disabled === true} onPress={cancel.onPress} style={stacked ? FULL_WIDTH : undefined} />;
}

function Lines({ note, error }: { note: string | undefined; error: string | null | undefined }): ReactNode {
  return (
    <>
      {error === null || error === undefined ? null : (
        <Text size="xs" role="danger" accessibilityLiveRegion="polite">
          {error}
        </Text>
      )}
      {note === undefined ? null : (
        <Text size="xs" role="secondary">
          {note}
        </Text>
      )}
    </>
  );
}

export function Actions({ main, cancel, note, error }: ActionsProps): ReactNode {
  const stacked = useIsStacked();
  if (stacked)
    return (
      <Col gap={12}>
        <Lines note={note} error={error} />
        {main === undefined ? null : <MainButton main={main} stacked />}
        {cancel === undefined ? null : <CancelButton cancel={cancel} stacked />}
      </Col>
    );
  return (
    <Col gap={12}>
      {error === null || error === undefined ? null : <Lines note={undefined} error={error} />}
      <Row align="center" justify="between" gap={16}>
        <Col flex={1} minWidth={0}>
          <Lines note={note} error={null} />
        </Col>
        <Row align="center" gap={12}>
          {cancel === undefined ? null : <CancelButton cancel={cancel} stacked={false} />}
          {main === undefined ? null : <MainButton main={main} stacked={false} />}
        </Row>
      </Row>
    </Col>
  );
}
