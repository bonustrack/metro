import { type ReactNode } from 'react';
import { Col } from '@stage-labs/kit/react-native/box';
import { Button } from '@stage-labs/kit/react-native/button';
import { Text } from '@stage-labs/kit/react-native/text';
import { useKitPalette, useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Icon, type IconName } from '../Icon.js';
import { Spinner } from '../Spinner.js';
import { ICON_SIZE } from './sizes.js';

const ICON = ICON_SIZE.lg;
const TEXT_WIDTH = 420;

interface StateAction {
  label: string;
  onPress: () => void;
  icon?: IconName;
  busy?: boolean;
  primary?: boolean;
}

function ActionButton({ action }: { action: StateAction }): ReactNode {
  const palette = useKitPalette();
  const dark = useKitScheme() === 'dark';
  const primary = action.primary === true;
  const icon = action.icon === undefined ? undefined : <Icon name={action.icon} size={ICON_SIZE.md} color={primary ? palette.bg : palette.link} />;
  return <Button size="md" color={primary ? 'primary' : 'secondary'} dark={dark} label={action.label} icon={icon} loading={action.busy} disabled={action.busy} onPress={action.onPress} />;
}

interface StateBlockProps {
  icon?: IconName;
  spinner?: boolean;
  danger?: boolean;
  title: string;
  text?: string;
  action?: StateAction;
  children?: ReactNode;
}

function Mark({ icon, spinner, danger }: Pick<StateBlockProps, 'icon' | 'spinner' | 'danger'>): ReactNode {
  const palette = useKitPalette();
  if (spinner === true) return <Spinner color={palette.link} />;
  if (icon === undefined) return null;
  return <Icon name={icon} size={ICON} color={danger === true ? palette.danger : palette.text} />;
}

export function StateBlock({ icon, spinner, danger, title, text, action, children }: StateBlockProps): ReactNode {
  return (
    <Col gap={8} align="start">
      <Col margin={{ bottom: 6 }}>
        <Mark icon={icon} spinner={spinner} danger={danger} />
      </Col>
      <Text size="md" weight="semibold">
        {title}
      </Text>
      {text === undefined ? null : (
        <Col maxWidth={TEXT_WIDTH}>
          <Text size="xs" role="secondary">
            {text}
          </Text>
        </Col>
      )}
      {children}
      {action === undefined ? null : (
        <Col margin={{ top: 8 }}>
          <ActionButton action={action} />
        </Col>
      )}
    </Col>
  );
}
