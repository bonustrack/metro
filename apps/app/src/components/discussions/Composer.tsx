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
import { AttachButton, PickedChips } from './ComposerFiles.js';
import { addPicked, type PickedFile } from '../../lib/chat-files.js';
import { pickChatFiles, releasePicked, usePastedFiles, type PickSource } from '../../lib/chat-pick.js';
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
  attach?: boolean;
  onSend: (text: string, files: PickedFile[]) => Promise<void>;
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

interface BoxProps {
  field: ReactNode;
  action: ReactNode;
  toolbar: ReactNode;
  attach: ReactNode;
  chips: ReactNode;
}

function Box({ field, action, toolbar, attach, chips }: BoxProps): ReactNode {
  const palette = useKitPalette();
  if (toolbar === undefined || toolbar === null)
    return (
      <Column gap={8} radius="sm" padding={{ left: 8, right: 10, y: 10 }} background={palette.border}>
        {chips}
        <Row align="end" gap={8}>
          {attach === null ? null : <Column>{attach}</Column>}
          {field}
          <Column>{action}</Column>
        </Row>
      </Column>
    );
  return (
    <Column gap={4} radius="sm" padding={{ x: 10, top: 8, bottom: 10 }} background={palette.border}>
      {chips}
      <Row>{field}</Row>
      <Row align="center" gap={6}>
        {attach}
        {toolbar}
        <Column weight={1} />
        {action}
      </Row>
    </Column>
  );
}

const sendable = (text: string, files: readonly PickedFile[], busy: boolean, props: ComposerProps): boolean =>
  (text.trim() !== '' || files.length > 0) && !busy && !props.waiting && props.locked !== true && props.blocked === null;

const fieldOf = (props: ComposerProps): { placeholder: string; disabled: boolean } => ({ placeholder: props.blocked ?? props.placeholder, disabled: props.locked === true || props.blocked !== null });

const dockPadding = (docked: boolean, inset: number): { top: number; bottom: number } => (docked ? { top: 8, bottom: DOCK_GAP + inset } : { top: 0, bottom: 0 });

interface ComposerFiles {
  files: PickedFile[];
  refused: string | null;
  pick: (source: PickSource) => void;
  remove: (key: string) => void;
  clear: () => void;
}

function useComposerFiles(attach: boolean): ComposerFiles {
  const [files, setFiles] = useState<PickedFile[]>([]);
  const [refused, setRefused] = useState<string | null>(null);
  const add = (picked: PickedFile[]): void => {
    if (picked.length === 0) return;
    const added = addPicked(files, picked);
    for (const file of picked) if (!added.files.includes(file)) releasePicked(file);
    setFiles(added.files);
    setRefused(added.refused);
  };
  usePastedFiles(attach, add);
  const pick = (source: PickSource): void => {
    pickChatFiles(source)
      .then(add)
      .catch((err: unknown) => { setRefused(queryError(err, 'The files could not be read.')); });
  };
  const remove = (key: string): void => {
    for (const file of files) if (file.key === key) releasePicked(file);
    setFiles(files.filter((file) => file.key !== key));
    setRefused(null);
  };
  const clear = (): void => {
    setFiles([]);
    setRefused(null);
  };
  return { files, refused, pick, remove, clear };
}

export function Composer(props: ComposerProps): ReactNode {
  const { docked = false, autoFocus = false, rows = 1, toolbar, attach = false, onSend, onStop } = props;
  const palette = useKitPalette();
  const insets = useSafeAreaInsets();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const picked = useComposerFiles(attach);
  const files = attach ? picked.files : [];
  const ready = sendable(text, files, busy, props);
  const field = fieldOf(props);
  const send = (): void => {
    if (!ready) return;
    const said = text.trim();
    setBusy(true);
    setFailed(null);
    onSend(said, files)
      .then(() => {
        setText('');
        picked.clear();
      })
      .catch((err: unknown) => { setFailed(queryError(err, 'The message was not sent.')); })
      .finally(() => { setBusy(false); });
  };
  return (
    <Column gap={6} padding={dockPadding(docked, insets.bottom)} background={palette.bg} style={docked ? DOCKED : undefined}>
      <Box
        field={<Field rows={rows} text={text} setText={setText} placeholder={field.placeholder} disabled={field.disabled} autoFocus={autoFocus} onEnter={send} />}
        action={<Action ready={ready} onSend={send} onStop={onStop} stopping={props.stopping === true} />}
        toolbar={toolbar}
        attach={attach ? <AttachButton disabled={busy} onPick={picked.pick} /> : null}
        chips={<PickedChips files={files} onRemove={picked.remove} />}
      />
      {picked.refused === null ? null : <Text size="sm" color="danger">{picked.refused}</Text>}
      {failed === null ? null : <Text size="sm" color="danger">{failed}</Text>}
    </Column>
  );
}
