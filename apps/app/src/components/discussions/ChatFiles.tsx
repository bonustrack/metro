import { createContext, Fragment, type ReactNode, useContext, useRef, useState } from 'react';
import { Pressable, StyleSheet, useWindowDimensions, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { withAlpha } from '@stage-labs/kit/badge';
import { Column } from '@stage-labs/kit/react-native/column';
import { Image } from '@stage-labs/kit/react-native/image';
import { Modal } from '@stage-labs/kit/react-native/modal';
import { Row } from '@stage-labs/kit/react-native/row';
import { Text } from '@stage-labs/kit/react-native/text';
import { useKitPalette, type KitPalette } from '@stage-labs/kit/react-native/theme-context';
import type { ChatFile } from '@metro-labs/core/chat';
import { fetchChatFile } from '@metro-labs/client/api/chat-files';
import { ForbiddenError, NotFoundError } from '@metro-labs/client/api/client';
import { viewTicket } from '@metro-labs/client/api/chats';
import { Icon } from '../Icon.js';
import { Spinner } from '../Spinner.js';
import { allSides } from '../ui/edges.js';
import { RoundButton } from '../ui/RoundButton.js';
import { ICON_SIZE } from '../ui/sizes.js';
import { isInlineImage, sizeWords } from '../../lib/chat-files.js';
import { saveChatFile, useBlobUri } from '../../lib/chat-file-view.js';
import { previewOf, uploadStateOf, useUploads, type UploadState } from '../../lib/chat-uploads.js';
import { logError } from '../../lib/log.js';
import { orgKey, queryError } from '../../lib/queries.js';
import { shapeColor } from '../../lib/theme.js';
import { SHRINK } from '../../lib/style.js';

export interface FileSource {
  host: string | null;
  chat: string;
  ticket: string;
}

export const ChatFileContext = createContext<FileSource>({ host: null, chat: '', ticket: '' });

const THUMB_WIDTH = 240;
const THUMB_HEIGHT = 180;
const CHIP_WIDTH = 280;
const VIEW_PAD = 48;
const CLOSE_GAP = 16;
const BACKDROP_ALPHA = 0.92;
const WAITING_OPACITY = 0.5;

const styles = StyleSheet.create({
  thumb: { width: THUMB_WIDTH, maxWidth: '100%', height: THUMB_HEIGHT, borderRadius: 10, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' },
  fill: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 },
  center: { alignItems: 'center', justifyContent: 'center' },
  waiting: { opacity: WAITING_OPACITY },
  close: { position: 'absolute' },
});

const NOT_SENT = 'Not sent.';

function goneWords(settled: boolean, state: UploadState | null): string {
  if (state === 'unsent') return NOT_SENT;
  return settled ? "No longer on the agent's server." : "Not on the agent's server yet.";
}

async function readFile(source: FileSource, file: string, ticket: () => string): Promise<Blob> {
  if (source.host === null) throw new Error('This agent has no server.');
  try {
    return await fetchChatFile(source.host, source.chat, file, ticket());
  } catch (err) {
    if (!(err instanceof ForbiddenError)) throw err;
    return fetchChatFile(source.host, source.chat, file, await viewTicket(source.chat));
  }
}

function useTicket(): { source: FileSource; ticket: () => string } {
  const source = useContext(ChatFileContext);
  const current = useRef(source.ticket);
  current.current = source.ticket;
  return { source, ticket: () => current.current };
}

function useFileBlob(file: ChatFile, wanted: boolean, settled: boolean): UseQueryResult<Blob> {
  const { source, ticket } = useTicket();
  return useQuery({
    queryKey: orgKey('chat-file', source.host ?? '', source.chat, file.id, settled ? 'settled' : 'open'),
    queryFn: () => readFile(source, file.id, ticket),
    enabled: wanted,
    staleTime: Infinity,
    retry: (count, err) => !(err instanceof NotFoundError) && count < 2,
  });
}

function UploadMark({ state }: { state: UploadState | null }): ReactNode {
  const palette = useKitPalette();
  if (state === 'sending') return <Spinner color={palette.sub} />;
  return state === 'failed' ? <Icon name="exclamationCircle" size={ICON_SIZE.md} color={palette.danger} /> : null;
}

function Viewer({ uri, name, onClose }: { uri: string; name: string; onClose: () => void }): ReactNode {
  const palette = useKitPalette();
  const screen = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const box = StyleSheet.flatten([styles.fill, styles.center, { backgroundColor: withAlpha(palette.bg, BACKDROP_ALPHA) }]);
  const corner = StyleSheet.flatten([styles.close, { top: insets.top + CLOSE_GAP, right: insets.right + CLOSE_GAP }]);
  return (
    <Modal open onClose={onClose} animationType="none" fullBleedPanel>
      <Pressable accessibilityRole="button" accessibilityLabel="Close the image" onPress={onClose} style={box}>
        <Image url={uri} description={name} fit="contain" width={Math.max(0, screen.width - 2 * VIEW_PAD)} height={Math.max(0, screen.height - 2 * VIEW_PAD)} />
      </Pressable>
      <Column style={corner}>
        <RoundButton label="Close" icon="close" onPress={onClose} />
      </Column>
    </Modal>
  );
}

interface ShownImage {
  uri: string | null;
  failure: Error | null;
  retry: () => void;
}

function useImageUri(file: ChatFile, settled: boolean): ShownImage {
  const local = previewOf(file.id);
  const read = useFileBlob(file, local === null, settled);
  const fetched = useBlobUri(read.data);
  const retry = (): void => { read.refetch().catch(logError('chat image')); };
  if (local !== null) return { uri: local, failure: null, retry };
  const failure = read.error ?? (fetched === null ? new Error('The image could not be read.') : null);
  return { uri: fetched ?? null, failure, retry };
}

const thumbFrame = (palette: KitPalette, loaded: boolean, state: UploadState | null): ViewStyle =>
  StyleSheet.flatten([styles.thumb, loaded ? null : { backgroundColor: shapeColor(palette) }, state === 'waiting' ? styles.waiting : null]);

interface BrokenProps {
  file: ChatFile;
  failure: Error;
  settled: boolean;
  state: UploadState | null;
  onRetry: () => void;
}

function BrokenImage({ file, failure, settled, state, onRetry }: BrokenProps): ReactNode {
  const palette = useKitPalette();
  const words = failure instanceof NotFoundError ? goneWords(settled, state) : 'Could not load this image. Tap to try again.';
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={`${file.name}. ${words}`} onPress={onRetry} style={thumbFrame(palette, false, null)}>
      <Column align="center" gap={6} padding={12}>
        <Icon name="image" size={ICON_SIZE.lg} color={palette.sub} />
        <Text size="sm" numberOfLines={1}>{file.name}</Text>
        <Text size="xs" color="secondary">{words}</Text>
      </Column>
    </Pressable>
  );
}

function ImageFile({ file, state, settled }: { file: ChatFile; state: UploadState | null; settled: boolean }): ReactNode {
  const palette = useKitPalette();
  const { uri, failure, retry } = useImageUri(file, settled);
  const [loaded, setLoaded] = useState(false);
  const [open, setOpen] = useState(false);
  if (failure !== null) return <BrokenImage file={file} failure={failure} settled={settled} state={state} onRetry={retry} />;
  const frame = thumbFrame(palette, loaded, state);
  return (
    <Fragment>
      <Pressable accessibilityRole="button" accessibilityLabel={`Open ${file.name}`} disabled={uri === null || !loaded} onPress={() => { setOpen(true); }} style={frame}>
        {uri === null ? null : <Image url={uri} description={file.name} fit="cover" style={styles.fill} onLoad={() => { setLoaded(true); }} />}
        <UploadMark state={state} />
      </Pressable>
      {open && uri !== null ? <Viewer uri={uri} name={file.name} onClose={() => { setOpen(false); }} /> : null}
    </Fragment>
  );
}

function ChipMark({ busy, state }: { busy: boolean; state: UploadState | null }): ReactNode {
  const palette = useKitPalette();
  if (busy || state === 'sending') return <Spinner color={palette.sub} />;
  return state === 'failed' ? <Icon name="exclamationCircle" size={ICON_SIZE.md} color={palette.danger} /> : <Icon name="file" size={ICON_SIZE.md} color={palette.sub} />;
}

function FileChip({ file, state, settled }: { file: ChatFile; state: UploadState | null; settled: boolean }): ReactNode {
  const palette = useKitPalette();
  const { source, ticket } = useTicket();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const uploading = state === 'waiting' || state === 'sending' || state === 'failed';
  const save = (): void => {
    setBusy(true);
    setProblem(null);
    readFile(source, file.id, ticket)
      .then((blob) => saveChatFile(blob, file))
      .catch((err: unknown) => { setProblem(err instanceof NotFoundError ? goneWords(settled, state) : queryError(err, 'The file could not be opened.')); })
      .finally(() => { setBusy(false); });
  };
  const frame = state === 'waiting' ? styles.waiting : undefined;
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={`Download ${file.name}`} disabled={busy || uploading || source.host === null} onPress={save} style={frame}>
      <Row align="center" gap={10} radius={10} border={allSides(palette.border)} padding={{ x: 12, y: 8 }} maxWidth={CHIP_WIDTH}>
        <ChipMark busy={busy} state={state} />
        <Column minWidth={0} style={SHRINK}>
          <Text size="sm" fontWeight="semibold" numberOfLines={1}>{file.name}</Text>
          <Text size="xs" color="secondary" numberOfLines={2}>{problem ?? (state === 'unsent' ? NOT_SENT : sizeWords(file.size))}</Text>
        </Column>
        {uploading ? null : <Icon name="arrowDown" size={ICON_SIZE.sm} color={palette.sub} />}
      </Row>
    </Pressable>
  );
}

export function FileView({ file, state = null, settled = true }: { file: ChatFile; state?: UploadState | null; settled?: boolean }): ReactNode {
  return isInlineImage(file.type) ? <ImageFile file={file} state={state} settled={settled} /> : <FileChip file={file} state={state} settled={settled} />;
}

export function MessageFiles({ message, files, settled }: { message: string; files: readonly ChatFile[]; settled: boolean }): ReactNode {
  const uploads = useUploads(message);
  if (files.length === 0) return null;
  return (
    <Row wrap gap={8}>
      {files.map((file) => <FileView key={file.id} file={file} state={uploadStateOf(uploads, file.id)} settled={settled} />)}
    </Row>
  );
}
