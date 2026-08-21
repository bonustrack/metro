import { type ReactNode, useMemo } from 'react';
import makeBlockie from 'ethereum-blockies-base64';
import { AvatarView } from '@stage-labs/kit/react-native/avatar-view';

export function AgentAvatar({
  seed,
  size,
}: {
  seed: string;
  size: number;
}): ReactNode {
  const src = useMemo(() => makeBlockie(seed), [seed]);
  return <AvatarView src={src} size={size} alt="" />;
}
