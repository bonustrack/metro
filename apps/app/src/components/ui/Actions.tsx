import { type ReactNode } from 'react';
import { Column } from '@stage-labs/kit/react-native/column';
import { Row } from '@stage-labs/kit/react-native/row';
import { Button } from '@stage-labs/kit/react-native/button';
import { Text } from '@stage-labs/kit/react-native/text';
import { useIsStacked } from '../../lib/media.js';
import { FULL_WIDTH } from '../../lib/style.js';

interface MainAction {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  busy?: boolean;
  danger?: boolean;
}

interface CancelAction {
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
  const busy = main.busy === true;
  return (
    <Button
      size={stacked ? 'lg' : 'md'}
      color={main.danger === true ? 'danger' : 'primary'}
      label={main.label}
      loading={busy}
      disabled={busy || main.disabled === true}
      onPress={main.onPress}
      style={stacked ? FULL_WIDTH : undefined}
    />
  );
}

function CancelButton({ cancel, stacked }: { cancel: CancelAction; stacked: boolean }): ReactNode {
  return <Button size={stacked ? 'lg' : 'md'} color="secondary" label={cancel.label ?? 'Cancel'} disabled={cancel.disabled === true} onPress={cancel.onPress} style={stacked ? FULL_WIDTH : undefined} />;
}

function Lines({ note, error }: { note: string | undefined; error: string | null | undefined }): ReactNode {
  return (
    <>
      {error === null || error === undefined ? null : (
        <Text size="xs" color="danger" accessibilityLiveRegion="polite">
          {error}
        </Text>
      )}
      {note === undefined ? null : (
        <Text size="xs" color="secondary">
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
      <Column gap={12}>
        <Lines note={note} error={error} />
        {main === undefined ? null : <MainButton main={main} stacked />}
        {cancel === undefined ? null : <CancelButton cancel={cancel} stacked />}
      </Column>
    );
  return (
    <Column gap={12}>
      {error === null || error === undefined ? null : <Lines note={undefined} error={error} />}
      <Row align="center" justify="spaceBetween" gap={16}>
        <Column weight={1} minWidth={0}>
          <Lines note={note} error={null} />
        </Column>
        <Row align="center" gap={12}>
          {cancel === undefined ? null : <CancelButton cancel={cancel} stacked={false} />}
          {main === undefined ? null : <MainButton main={main} stacked={false} />}
        </Row>
      </Row>
    </Column>
  );
}
