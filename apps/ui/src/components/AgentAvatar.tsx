import { type ReactNode, useMemo } from 'react';
import makeBlockie from 'ethereum-blockies-base64';
import { AvatarView } from '@stage-labs/kit/react-native/avatar-view';

export function AgentAvatar({
  seed,
  src = null,
  size,
}: {
  seed: string;
  src?: string | null;
  size: number;
}): ReactNode {
  const fallback = useMemo(() => makeBlockie(seed), [seed]);
  return <AvatarView src={src ?? fallback} size={size} alt="" />;
}
