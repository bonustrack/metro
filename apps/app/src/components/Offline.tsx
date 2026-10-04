import { type ReactNode } from 'react';
import { Col } from '@stage-labs/kit/react-native/box';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Button } from '@stage-labs/kit/react-native/button';
import { Text } from '@stage-labs/kit/react-native/text';
import { type Selection } from '@metro-labs/client/selection';

const OFFLINE_PAGES: Selection['kind'][] = ['agent-settings', 'settings'];

export const worksOffline = (kind: Selection['kind']): boolean => OFFLINE_PAGES.includes(kind);

export function OfflinePanel({ onRetry }: { onRetry: () => void }): ReactNode {
  const dark = useKitScheme() === 'dark';
  return (
    <Col gap={20}>
      <Text size="2xs" role="secondary">
        Nothing on this page can be read while the box does not answer.
      </Text>
      <Button size="md" color="secondary" dark={dark} label="Try again" onPress={onRetry} />
    </Col>
  );
}
