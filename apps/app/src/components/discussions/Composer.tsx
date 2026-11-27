import { type ReactNode, useState } from 'react';
import { type NativeSyntheticEvent, type TextInputKeyPressEventData } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Button } from '@stage-labs/kit/react-native/button';
import { Column } from '@stage-labs/kit/react-native/column';
import { Row } from '@stage-labs/kit/react-native/row';
import { Text } from '@stage-labs/kit/react-native/text';
import { TextField } from '@stage-labs/kit/react-native/text-field';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { FONT_SIZE, fontName } from '@stage-labs/kit/tokens';
import { CHAT_TEXT_MAX } from '@metro-labs/core/chat';
import { Icon } from '../Icon.js';
import { ICON_SIZE } from '../ui/sizes.js';
import { queryError } from '../../lib/queries.js';
import { webOnly, WEB } from '../../lib/style.js';

const DOCKED = webOnly({ position: 'sticky', bottom: 0, zIndex: 3 });
const DOCK_GAP = 20;
const LINE = 23;
const FIELD_PAD = 8;
const FIELD = { autoCapitalize: 'sentences', autoCorrect: true } as const;

interface ComposerProps {
  placeholder: string;
  waiting: boolean;
  locked?: boolean;
  blocked: string | null;
  docked?: boolean;
  autoFocus?: boolean;
  rows?: number;
  toolbar?: ReactNode;
  onSend: (text: string) => Promise<void>;
  onStop?: () => void;
  stopping?: boolean;
}

const plainEnter = (event: NativeSyntheticEvent<TextInputKeyPressEventData>): boolean => {
  const native: { key?: string; shiftKey?: boolean; isComposing?: boolean } = event.nativeEvent;
  return WEB && native.key === 'Enter' && native.shiftKey !== true && native.isComposing !== true;
};

function Action({ ready, onSend, onStop, stopping }: { ready: boolean; onSend: () => void; onStop?: () => void; stopping: boolean }): ReactNode {
  const palette = useKitPalette();
  const stop = onStop !== undefined;
  return (
    <Button
      variant="primary"
      size="md"
      uniform
      pill
      accessibilityLabel={stop ? 'Stop' : 'Send'}
      disabled={stop ? stopping : !ready}
      onPress={onStop ?? onSend}
      icon={<Icon name={stop ? 'stop' : 'arrowUp'} size={ICON_SIZE.md} color={palette.bg} />}
    />
  );
}

interface FieldProps {
  rows: number;
  text: string;
  setText: (text: string) => void;
  placeholder: string;
  disabled: boolean;
  autoFocus: boolean;
  onEnter: () => void;
}

function Field({ rows, text, setText, placeholder, disabled, autoFocus, onEnter }: FieldProps): ReactNode {
  const tall = LINE * rows + 2 * FIELD_PAD;
  const palette = useKitPalette();
  const [placed, setPlaced] = useState(false);
  const keys = (event: NativeSyntheticEvent<TextInputKeyPressEventData>): void => {
    if (!plainEnter(event)) return;
    event.preventDefault();
    onEnter();
  };
  return (
    <Column weight={1} minWidth={0} minHeight={tall} onLayout={() => { setPlaced(true); }}>
      {placed ? (
        <TextField
          value={text}
          onChangeText={setText}
          placeholder={placeholder}
          variant="longText"
          appearance="plain"
          autoGrow
          rows={1}
          fontSize={FONT_SIZE.lg}
          fontFamily={fontName.sans}
          color={palette.link}
          placeholderColor={palette.sub}
          paddingX={FIELD_PAD}
          paddingTop={FIELD_PAD}
          paddingBottom={FIELD_PAD}
          lineHeight={LINE}
          minHeight={tall}
          maxHeight={210}
          maxLength={CHAT_TEXT_MAX}
          disabled={disabled}
          autoFocus={autoFocus}
          onKeyPress={keys}
          {...FIELD}
        />
      ) : null}
    </Column>
  );
}

function Box({ field, action, toolbar }: { field: ReactNode; action: ReactNode; toolbar: ReactNode }): ReactNode {
  const palette = useKitPalette();
  if (toolbar === undefined || toolbar === null)
    return (
      <Row align="end" gap={8} radius="sm" padding={{ left: 8, right: 10, y: 10 }} background={palette.border}>
        {field}
        <Column>{action}</Column>
      </Row>
    );
  return (
    <Column gap={4} radius="sm" padding={{ x: 10, top: 8, bottom: 10 }} background={palette.border}>
      <Row>{field}</Row>
      <Row align="center" gap={6}>
        {toolbar}
        <Column weight={1} />
        {action}
      </Row>
    </Column>
  );
}

const sendable = (text: string, busy: boolean, props: ComposerProps): boolean => text.trim() !== '' && !busy && !props.waiting && props.locked !== true && props.blocked === null;

const fieldOf = (props: ComposerProps): { placeholder: string; disabled: boolean } => ({ placeholder: props.blocked ?? props.placeholder, disabled: props.locked === true || props.blocked !== null });

const dockPadding = (docked: boolean, inset: number): { top: number; bottom: number } => (docked ? { top: 8, bottom: DOCK_GAP + inset } : { top: 0, bottom: 0 });

export function Composer(props: ComposerProps): ReactNode {
  const { docked = false, autoFocus = false, rows = 1, toolbar, onSend, onStop } = props;
  const palette = useKitPalette();
  const insets = useSafeAreaInsets();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const ready = sendable(text, busy, props);
  const field = fieldOf(props);
  const send = (): void => {
    if (!ready) return;
    const said = text.trim();
    setBusy(true);
    setFailed(null);
    onSend(said)
      .then(() => { setText(''); })
      .catch((err: unknown) => { setFailed(queryError(err, 'The message was not sent.')); })
      .finally(() => { setBusy(false); });
  };
  return (
    <Column gap={6} padding={dockPadding(docked, insets.bottom)} background={palette.bg} style={docked ? DOCKED : undefined}>
      <Box
        field={<Field rows={rows} text={text} setText={setText} placeholder={field.placeholder} disabled={field.disabled} autoFocus={autoFocus} onEnter={send} />}
        action={<Action ready={ready} onSend={send} onStop={onStop} stopping={props.stopping === true} />}
        toolbar={toolbar}
      />
      {failed === null ? null : <Text size="sm" color="danger">{failed}</Text>}
    </Column>
  );
}
