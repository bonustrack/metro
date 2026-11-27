import { type ReactNode } from 'react';
import { Animated } from 'react-native';
import { Column } from '@stage-labs/kit/react-native/column';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import type { ChatActivity } from '@metro-labs/client/api/chats';
import { usePulse } from '../BootLoading.js';

const DOT = 8;

function WorkingDot(): ReactNode {
  const palette = useKitPalette();
  const opacity = usePulse();
  const pulse = { opacity };
  return (
    <Animated.View accessibilityLabel="The agent is working" style={pulse}>
      <Column width={DOT} height={DOT} radius="full" background={palette.sub} />
    </Animated.View>
  );
}

export function ActivityDot({ activity }: { activity: ChatActivity }): ReactNode {
  const palette = useKitPalette();
  if (activity === 'working') return <WorkingDot />;
  if (activity === 'unread') return <Column accessibilityLabel="A new reply" width={DOT} height={DOT} radius="full" background={palette.link} />;
  return null;
}
