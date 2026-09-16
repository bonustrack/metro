import type { ReactNode } from 'react';
import { Row } from '@stage-labs/kit/react-native/box';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { useServerStatus } from '../api/queries.js';

const DOT = 8;

export function StatusDot({ host }: { host: string }): ReactNode {
  const palette = useKitPalette();
  const { data } = useServerStatus(host);
  const color =
    data === undefined ? palette.border : data.state === 'live' ? palette.success : data.state === 'stopped' ? palette.danger : palette.sub;
  return <Row width={DOT} height={DOT} radius={DOT} background={color} />;
}
