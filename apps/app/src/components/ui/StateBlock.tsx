import { type ReactNode } from 'react';
import { Column } from '@stage-labs/kit/react-native/column';
import { Button } from '@stage-labs/kit/react-native/button';
import { Text } from '@stage-labs/kit/react-native/text';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
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
  const primary = action.primary === true;
  const icon = action.icon === undefined ? undefined : <Icon name={action.icon} size={ICON_SIZE.md} color={primary ? palette.bg : palette.link} />;
  return <Button size="md" color={primary ? 'primary' : 'secondary'} label={action.label} icon={icon} loading={action.busy} disabled={action.busy} onPress={action.onPress} />;
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
    <Column gap={8} align="start">
      <Column margin={{ bottom: 6 }}>
        <Mark icon={icon} spinner={spinner} danger={danger} />
      </Column>
      <Text size="md" fontWeight="semibold">
        {title}
      </Text>
      {text === undefined ? null : (
        <Column maxWidth={TEXT_WIDTH}>
          <Text size="xs" color="secondary">
            {text}
          </Text>
        </Column>
      )}
      {children}
      {action === undefined ? null : (
        <Column margin={{ top: 8 }}>
          <ActionButton action={action} />
        </Column>
      )}
    </Column>
  );
}
