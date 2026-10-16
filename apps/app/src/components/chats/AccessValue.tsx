import { type ReactNode } from 'react';
import { Row } from '@stage-labs/kit/react-native/box';
import { Text } from '@stage-labs/kit/react-native/text';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { type Access } from '@metro-labs/client/api/policy';
import { Icon, type IconName } from '../Icon.js';
import { shownWord, type RuleShown } from '../../lib/channel-rules.js';

const MARK = 18;

const ICON: Record<Access, IconName> = { allow: 'check', ask: 'question', deny: 'ban' };

export function AccessValue({ shown, quiet = false }: { shown: RuleShown; quiet?: boolean }): ReactNode {
  const palette = useKitPalette();
  const color = quiet || shown === 'mixed' ? palette.sub : shown === 'allow' ? palette.success : shown === 'deny' ? palette.danger : palette.link;
  return (
    <Row align="center" gap={6}>
      {shown === 'mixed' ? null : <Icon name={ICON[shown]} size={MARK} color={color} />}
      <Text size="md" color={color} numberOfLines={1}>
        {shownWord(shown)}
      </Text>
    </Row>
  );
}
