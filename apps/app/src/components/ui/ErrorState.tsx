import { type ReactNode, useState } from 'react';
import { StateBlock } from './StateBlock.js';
import { logError } from '../../lib/log.js';

interface ErrorStateProps {
  title: string;
  text?: string;
  onRetry: () => unknown;
}

export function ErrorState({ title, text, onRetry }: ErrorStateProps): ReactNode {
  const [busy, setBusy] = useState(false);
  const retry = (): void => {
    setBusy(true);
    Promise.resolve()
      .then(onRetry)
      .catch(logError('retry'))
      .finally(() => {
        setBusy(false);
      });
  };
  return <StateBlock icon="exclamationCircle" danger title={title} text={text} action={{ label: 'Retry', icon: 'refresh', busy, onPress: retry }} />;
}
