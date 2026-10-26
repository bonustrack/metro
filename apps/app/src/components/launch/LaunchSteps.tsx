import { type ReactNode } from 'react';
import { Column } from '@stage-labs/kit/react-native/column';
import { Row } from '@stage-labs/kit/react-native/row';
import { Button } from '@stage-labs/kit/react-native/button';
import { Text } from '@stage-labs/kit/react-native/text';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { regionName } from '@metro-labs/client/aws/regions';
import { AgentAvatar } from '../AgentAvatar.js';
import { FormField } from '../FormField.js';
import { Icon } from '../Icon.js';
import { Rows } from '../ui/Group.js';
import { Item } from '../ui/Item.js';
import type { AvatarPicker } from '../AvatarPicker.js';
import type { LaunchKind } from './LaunchFrame.js';
import { cityOf } from '../../lib/launch-steps.js';

const PREVIEW = 72;
const NO_AUTOFILL = { autoComplete: 'off', autoCorrect: false } as const;

function Heading({ title, text }: { title: string; text: string }): ReactNode {
  return (
    <Column gap={8}>
      <Text accessibilityRole="header" size="2xl" fontWeight="semibold">{title}</Text>
      <Text size="md" color="secondary">{text}</Text>
    </Column>
  );
}

function Buttons({ next, ready, busy = false, onNext, onBack }: { next: string; ready: boolean; busy?: boolean; onNext: () => void; onBack?: () => void }): ReactNode {
  return (
    <Row gap={12} align="center">
      <Button size="lg" color="primary" label={next} loading={busy} disabled={!ready || busy} onPress={onNext} />
      {onBack === undefined ? null : <Button size="lg" color="secondary" label="Back" disabled={busy} onPress={onBack} />}
    </Row>
  );
}

export const seedOf = (name: string): string => (name.trim() === '' ? 'new agent' : name.trim());

interface NameProps {
  name: string;
  avatar: string | null;
  picker: AvatarPicker;
  onName: (name: string) => void;
  onNext: () => void;
  onBack?: () => void;
  text?: string;
  next?: string;
  busy?: boolean;
  error?: string | null;
}

export function NameStep({ name, avatar, picker, onName, onNext, onBack, text = 'People see this name in their chats. You can change it later.', next = 'Continue', busy = false, error = null }: NameProps): ReactNode {
  const ready = name.trim() !== '';
  return (
    <>
      <Heading title="Name your agent" text={text} />
      <Row align="center" gap={16} wrap>
        <AgentAvatar seed={seedOf(name)} src={avatar} size={PREVIEW} />
        <Row gap={8}>
          <Button size="md" color="secondary" label={avatar === null ? 'Choose a picture' : 'Change the picture'} disabled={picker.busy} onPress={picker.pick} />
          {avatar === null ? null : <Button size="md" color="secondary" label="Remove" onPress={picker.remove} />}
        </Row>
      </Row>
      {picker.error === null ? null : <Text size="md" color="danger">{picker.error}</Text>}
      <FormField label="Name" name="launch-name" value={name} placeholder="Rosa" autoFocus inputProps={NO_AUTOFILL} onChangeText={onName} onSubmit={() => { if (ready && !busy) onNext(); }} />
      {error === null ? null : <Text size="md" color="danger">{error}</Text>}
      <Buttons next={next} ready={ready} busy={busy} onNext={onNext} onBack={onBack} />
    </>
  );
}

interface KindProps {
  kind: LaunchKind | null;
  onKind: (kind: LaunchKind) => void;
  onNext: () => void;
}

function KindIcon({ name }: { name: 'server' | 'plug' }): ReactNode {
  const palette = useKitPalette();
  return <Icon name={name} size={24} color={palette.text} />;
}

export function KindStep({ kind, onKind, onNext }: KindProps): ReactNode {
  return (
    <>
      <Heading title="Does your agent need a server?" text="With a server, it answers in your chats and works on its own. Without one, it gives you the organization's connectors in Claude Code or any MCP client." />
      <Rows>
        <Item title="With a server" subtitle="Metro starts a server for it on AWS. It answers in your chats and runs on its own." chevron={false}
          leading={<KindIcon name="server" />} trailing={<Check on={kind === 'box'} />} onPress={() => { onKind('box'); }} />
        <Item title="Without a server" subtitle="Use its connectors from Claude Code on your computer, or any MCP client, with an access key." chevron={false}
          leading={<KindIcon name="plug" />} trailing={<Check on={kind === 'remote'} />} onPress={() => { onKind('remote'); }} />
      </Rows>
      <Buttons next="Continue" ready={kind !== null} onNext={onNext} />
    </>
  );
}

interface PlaceProps {
  name: string;
  regions: string[];
  closest: string | null;
  region: string;
  onRegion: (region: string) => void;
  onNext: () => void;
  onBack: () => void;
}

function Check({ on }: { on: boolean }): ReactNode {
  const palette = useKitPalette();
  return on ? <Icon name="check" size={20} color={palette.link} /> : null;
}

export function PlaceStep({ name, regions, closest, region, onRegion, onNext, onBack }: PlaceProps): ReactNode {
  return (
    <>
      <Heading title={`Where should ${seedOf(name)} live?`} text="Choose the place closest to you. Answers come faster, and the price is the same everywhere." />
      <Rows>
        {regions.map((code) => (
          <Item key={code} title={cityOf(regionName(code))} subtitle={regionName(code)} value={code === closest ? 'Closest' : undefined} chevron={false}
            trailing={<Check on={code === region} />} onPress={() => { onRegion(code); }} />
        ))}
      </Rows>
      <Buttons next="Continue" ready={region !== ''} onNext={onNext} onBack={onBack} />
    </>
  );
}

interface ConfirmProps {
  name: string;
  avatar: string | null;
  region: string;
  busy: boolean;
  onLaunch: () => void;
  onBack: () => void;
}

export function ConfirmStep({ name, avatar, region, busy, onLaunch, onBack }: ConfirmProps): ReactNode {
  const label = seedOf(name);
  return (
    <>
      <Heading title={`Launch ${label}`} text={`Metro starts a server for ${label} and sets it up. It is usually ready in about five minutes, and you can close the page while it works.`} />
      <Rows>
        <Item title="Name" value={label} leading={<AgentAvatar seed={label} src={avatar} size={32} />} />
        <Item title="Place" value={cityOf(regionName(region))} />
      </Rows>
      <Buttons next={`Launch ${label}`} ready busy={busy} onNext={onLaunch} onBack={onBack} />
    </>
  );
}
