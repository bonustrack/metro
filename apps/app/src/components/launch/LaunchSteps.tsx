import { type ReactNode } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { Button } from '@stage-labs/kit/react-native/button';
import { Text } from '@stage-labs/kit/react-native/text';
import { useKitPalette, useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { regionName } from '@metro-labs/client/aws/regions';
import { AgentAvatar } from '../AgentAvatar.js';
import { FormField } from '../FormField.js';
import { Icon } from '../Icon.js';
import { Rows } from '../ui/Group.js';
import { Item } from '../ui/Item.js';
import type { AvatarPicker } from '../AvatarPicker.js';
import { cityOf } from '../../lib/launch-steps.js';

const PREVIEW = 72;
const NO_AUTOFILL = { autoComplete: 'off', autoCorrect: false } as const;

function Heading({ title, text }: { title: string; text: string }): ReactNode {
  return (
    <Col gap={8}>
      <Text accessibilityRole="header" size="2xl" weight="semibold">{title}</Text>
      <Text size="md" role="secondary">{text}</Text>
    </Col>
  );
}

function Buttons({ next, ready, busy = false, onNext, onBack }: { next: string; ready: boolean; busy?: boolean; onNext: () => void; onBack?: () => void }): ReactNode {
  const dark = useKitScheme() === 'dark';
  return (
    <Row gap={12} align="center">
      <Button size="lg" color="primary" dark={dark} label={next} loading={busy} disabled={!ready || busy} onPress={onNext} />
      {onBack === undefined ? null : <Button size="lg" color="secondary" dark={dark} label="Back" disabled={busy} onPress={onBack} />}
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
}

export function NameStep({ name, avatar, picker, onName, onNext }: NameProps): ReactNode {
  const dark = useKitScheme() === 'dark';
  const ready = name.trim() !== '';
  return (
    <>
      <Heading title="Name your agent" text="People see this name in their chats. You can change it later." />
      <Row align="center" gap={16} wrap>
        <AgentAvatar seed={seedOf(name)} src={avatar} size={PREVIEW} />
        <Row gap={8}>
          <Button size="md" color="secondary" dark={dark} label={avatar === null ? 'Choose a picture' : 'Change the picture'} disabled={picker.busy} onPress={picker.pick} />
          {avatar === null ? null : <Button size="md" color="secondary" dark={dark} label="Remove" onPress={picker.remove} />}
        </Row>
      </Row>
      {picker.error === null ? null : <Text size="md" role="danger">{picker.error}</Text>}
      <FormField label="Name" name="launch-name" value={name} placeholder="Rosa" autoFocus dark={dark} inputProps={NO_AUTOFILL} onChangeText={onName} onSubmit={() => { if (ready) onNext(); }} />
      <Buttons next="Continue" ready={ready} onNext={onNext} />
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
