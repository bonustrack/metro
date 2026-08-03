import { type ReactNode, useState } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { Text } from '@stage-labs/kit/react-native/text';
import { Button } from '@stage-labs/kit/react-native/button';
import { Card } from '@stage-labs/kit/react-native/card';
import { Input } from '@stage-labs/kit/react-native/input';
import {
  useKitPalette,
  useKitScheme,
} from '@stage-labs/kit/react-native/theme-context';
import {
  attachAccount,
  stationLabel,
  STATION_FORMS,
  type AttachResult,
} from '../api/attach';
import { StationIcon } from './StationIcon';

interface AttachAccountProps {
  token: string;
  agentId: number;
  attachable: string[];
  onAttached: (result: AttachResult) => void;
}

function StationPicker({
  stations,
  picked,
  disabled,
  onPick,
}: {
  stations: string[];
  picked: string;
  disabled: boolean;
  onPick: (station: string) => void;
}): ReactNode {
  const dark = useKitScheme() === 'dark';
  const palette = useKitPalette();
  return (
    <Row gap={8} wrap>
      {stations.map((station) => (
        <Button
          key={station}
          size="sm"
          dark={dark}
          disabled={disabled}
          color={station === picked ? 'primary' : 'secondary'}
          variant={station === picked ? 'solid' : 'soft'}
          onPress={() => {
            onPick(station);
          }}
          label={stationLabel(station)}
          icon={
            <StationIcon
              station={station}
              size={14}
              color={station === picked ? palette.bg : palette.text}
            />
          }
        />
      ))}
    </Row>
  );
}

export function AttachAccount({
  token,
  agentId,
  attachable,
  onAttached,
}: AttachAccountProps): ReactNode {
  const dark = useKitScheme() === 'dark';
  const known = attachable.filter((s) => STATION_FORMS[s] !== undefined);
  const [picked, setPicked] = useState(known[0] ?? '');
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const form = STATION_FORMS[picked];
  if (known.length === 0 || form === undefined) return null;
  const field = form.fields[0];
  const ready = field === undefined || value.trim() !== '';

  const submit = (): void => {
    if (busy || !ready) return;
    setBusy(true);
    setError(null);
    const fields: Record<string, string> =
      field === undefined ? {} : { [field.key]: value.trim() };
    attachAccount(token, agentId, picked, fields)
      .then((result) => {
        setValue('');
        onAttached(result);
      })
      .catch((err: unknown) => {
        setError(
          err instanceof Error ? err.message : 'Could not attach the account.',
        );
      })
      .finally(() => {
        setBusy(false);
      });
  };

  return (
    <Card dark={dark} padding={18}>
      <Col gap={12}>
        <Col gap={2}>
          <Text size="lg" weight="semibold">
            Connect an account
          </Text>
          <Text size="sm" role="secondary">
            {form.hint}
          </Text>
        </Col>
        <StationPicker
          stations={known}
          picked={picked}
          disabled={busy}
          onPick={(station) => {
            setPicked(station);
            setValue('');
            setError(null);
          }}
        />
        <Row gap={10} align="center" wrap>
          {field === undefined ? null : (
            <Input
              name={`attach-${picked}`}
              value={value}
              placeholder={field.placeholder}
              inputType={field.secret ? 'password' : 'text'}
              disabled={busy}
              dark={dark}
              onChangeText={setValue}
              onSubmit={submit}
              style={{ flexGrow: 1, minWidth: 260 }}
            />
          )}
          <Button
            color="primary"
            dark={dark}
            onPress={submit}
            loading={busy}
            disabled={busy || !ready}
            label={field === undefined ? 'Generate and connect' : 'Connect'}
          />
        </Row>
        {error !== null ? (
          <Text size="sm" role="danger">
            {error}
          </Text>
        ) : null}
      </Col>
    </Card>
  );
}
