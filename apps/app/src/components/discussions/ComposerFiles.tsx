import { type ReactNode } from 'react';
import { Pressable, StyleSheet } from 'react-native';
import { Column } from '@stage-labs/kit/react-native/column';
import { Image } from '@stage-labs/kit/react-native/image';
import { Row } from '@stage-labs/kit/react-native/row';
import { Text } from '@stage-labs/kit/react-native/text';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { Dropdown, type MenuItem } from '../Dropdown.js';
import { Icon } from '../Icon.js';
import { useHover } from '../ui/hover.js';
import { ICON_SIZE, ROUND_BUTTON_SIZE } from '../ui/sizes.js';
import { sizeWords, type PickedFile } from '../../lib/chat-files.js';
import { PICK_SOURCES, type PickSource } from '../../lib/chat-pick.js';
import { hoverColor } from '../../lib/theme.js';
import { SHRINK } from '../../lib/style.js';

const THUMB = 32;
const CHIP_MAX = 240;

const styles = StyleSheet.create({
  attach: { width: ROUND_BUTTON_SIZE, height: ROUND_BUTTON_SIZE, borderRadius: ROUND_BUTTON_SIZE / 2, alignItems: 'center', justifyContent: 'center' },
  thumb: { width: THUMB, height: THUMB, borderRadius: 6 },
  dim: { opacity: 0.4 },
});

const SOURCE_ITEMS: Record<PickSource, Pick<MenuItem, 'label' | 'icon'>> = { photos: { label: 'Photos', icon: 'image' }, files: { label: 'Files', icon: 'file' } };

export function AttachButton({ disabled, onPick }: { disabled: boolean; onPick: (source: PickSource) => void }): ReactNode {
  const palette = useKitPalette();
  const [hovered, hover] = useHover();
  const lit = { backgroundColor: hoverColor(palette) };
  const mark = <Icon name="paperclip" size={ICON_SIZE.md} color={palette.sub} />;
  const only = PICK_SOURCES.length === 1 ? PICK_SOURCES[0] : undefined;
  if (only !== undefined || disabled) {
    const frame = StyleSheet.flatten([styles.attach, hovered && !disabled ? lit : null, disabled ? styles.dim : null]);
    return (
      <Pressable accessibilityRole="button" accessibilityLabel="Attach files" disabled={disabled} onPress={() => { onPick(only ?? 'files'); }} style={frame} {...hover}>
        {mark}
      </Pressable>
    );
  }
  const items = PICK_SOURCES.map((source) => ({ ...SOURCE_ITEMS[source], onSelect: () => { onPick(source); } }));
  return (
    <Dropdown label="Attach files" align="start" items={items} style={styles.attach} hoverStyle={lit}>
      {mark}
    </Dropdown>
  );
}

function PickedChip({ file, onRemove }: { file: PickedFile; onRemove: () => void }): ReactNode {
  const palette = useKitPalette();
  return (
    <Row align="center" gap={8} radius={8} padding={{ left: 6, right: 4, y: 4 }} background={palette.inputBg} maxWidth={CHIP_MAX}>
      {file.preview === null ? (
        <Column width={THUMB} height={THUMB} align="center" justify="center">
          <Icon name="file" size={ICON_SIZE.md} color={palette.sub} />
        </Column>
      ) : (
        <Image url={file.preview} description="" fit="cover" style={styles.thumb} />
      )}
      <Column minWidth={0} style={SHRINK}>
        <Text size="xs" fontWeight="semibold" numberOfLines={1}>{file.name}</Text>
        <Text size="3xs" color="secondary">{sizeWords(file.size)}</Text>
      </Column>
      <Pressable accessibilityRole="button" accessibilityLabel={`Remove ${file.name}`} hitSlop={6} onPress={onRemove}>
        <Icon name="close" size={ICON_SIZE.sm} color={palette.sub} />
      </Pressable>
    </Row>
  );
}

export function PickedChips({ files, onRemove }: { files: readonly PickedFile[]; onRemove: (key: string) => void }): ReactNode {
  if (files.length === 0) return null;
  return (
    <Row wrap gap={8}>
      {files.map((file) => <PickedChip key={file.key} file={file} onRemove={() => { onRemove(file.key); }} />)}
    </Row>
  );
}
