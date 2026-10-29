import { type ReactNode, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, type NativeSyntheticEvent, type TextInputKeyPressEventData } from 'react-native';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { FONT_SIZE, fontName } from '@stage-labs/kit/tokens';
import { logError } from '../../lib/log.js';

const TITLE_SIZE = FONT_SIZE['2xl'];

const styles = StyleSheet.create({
  title: { fontFamily: fontName.head, fontSize: TITLE_SIZE, lineHeight: Math.round(TITLE_SIZE * 1.25), padding: 0, margin: 0 },
  input: { borderWidth: 0, backgroundColor: 'transparent', outlineWidth: 0, outlineStyle: 'solid', minWidth: 0, width: '100%' },
});

interface EditableTitleProps {
  value: string;
  label: string;
  onRename?: (name: string) => Promise<unknown>;
}

export function EditableTitle({ value, label, onRename }: EditableTitleProps): ReactNode {
  const palette = useKitPalette();
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const color = { color: palette.link };
  const shown = saving ?? value;
  const finish = (): void => {
    const name = draft?.trim() ?? '';
    setDraft(null);
    if (onRename === undefined || name === '' || name === value) return;
    setSaving(name);
    onRename(name)
      .catch(logError('rename'))
      .finally(() => {
        setSaving(null);
      });
  };
  const onKeyPress = (event: NativeSyntheticEvent<TextInputKeyPressEventData>): void => {
    if (event.nativeEvent.key === 'Escape') setDraft(null);
  };
  if (draft !== null)
    return (
      <TextInput
        value={draft}
        accessibilityLabel={label}
        autoFocus
        selectTextOnFocus
        onChangeText={setDraft}
        onSubmitEditing={finish}
        onBlur={finish}
        onKeyPress={onKeyPress}
        style={[styles.title, styles.input, color]}
      />
    );
  const title = (
    <Text accessibilityRole="header" numberOfLines={2} style={[styles.title, color]}>
      {shown}
    </Text>
  );
  if (onRename === undefined || saving !== null) return title;
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={() => { setDraft(value); }}>
      {title}
    </Pressable>
  );
}
