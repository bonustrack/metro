import { type ReactNode } from 'react';
import { Col } from '@stage-labs/kit/react-native/box';
import { Button } from '@stage-labs/kit/react-native/button';
import { Text } from '@stage-labs/kit/react-native/text';
import { useKitPalette, useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Icon, type IconName } from '../Icon.js';
import { Spinner } from '../Spinner.js';

const ICON = 24;
const TEXT_WIDTH = 420;

interface StateAction {
  label: string;
  onPress: () => void;
  busy?: boolean;
  primary?: boolean;
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
  const dark = useKitScheme() === 'dark';
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
          <Button size="md" color={action.primary === true ? 'primary' : 'secondary'} dark={dark} label={action.label} loading={action.busy} disabled={action.busy} onPress={action.onPress} />
        </Col>
      )}
    </Col>
  );
}
