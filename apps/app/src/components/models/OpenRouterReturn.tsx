import { type ReactNode, useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Text } from '@stage-labs/kit/react-native/text';
import type { OpenRouterReturn } from '@metro-labs/client/api/org-models';
import { StateBlock } from '../ui/StateBlock.js';
import { afterModelChange } from '../../lib/model-queries.js';
import { takeInitialOpenRouterReturn } from '../../lib/location.js';
import { logError } from '../../lib/log.js';

export function useOpenRouterReturn(): OpenRouterReturn | null {
  const client = useQueryClient();
  const [back] = useState(takeInitialOpenRouterReturn);
  useEffect(() => {
    if (back !== null) afterModelChange(client).catch(logError('org-models'));
  }, [back, client]);
  return back;
}

export function OpenRouterNote({ back }: { back: OpenRouterReturn | null }): ReactNode {
  if (back === null) return null;
  if (back.kind === 'error') return <StateBlock icon="exclamationCircle" danger title="OpenRouter did not connect" text={back.error} />;
  return <Text size="xs" role="secondary">OpenRouter is connected. Pick one of its models for the default route.</Text>;
}
