import { type ReactNode, useState } from 'react';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { Text } from './ui';
import { connectorHost } from '../api/connectors';

interface ConnectorIconProps {
  name: string;
  url: string;
  icon: string;
  size: number;
}

function faviconOf(url: string): string {
  try {
    return `${new URL(url).origin}/favicon.ico`;
  } catch {
    return '';
  }
}

export function ConnectorIcon({
  name,
  url,
  icon,
  size,
}: ConnectorIconProps): ReactNode {
  const palette = useKitPalette();
  const [failed, setFailed] = useState<string[]>([]);
  const candidates = [icon, faviconOf(url)].filter(
    (src) => src !== '' && !failed.includes(src),
  );
  const src = candidates[0];
  const box = {
    width: size,
    height: size,
    borderRadius: Math.round(size / 4),
    flex: `0 0 ${String(size)}px`,
    overflow: 'hidden' as const,
  };

  if (src === undefined)
    return (
      <div
        style={{
          ...box,
          background: palette.inputBg,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Text size="sm" weight="semibold">
          {(name[0] ?? '?').toUpperCase()}
        </Text>
      </div>
    );

  return (
    <img
      src={src}
      alt=""
      width={size}
      height={size}
      loading="lazy"
      referrerPolicy="no-referrer"
      style={{ ...box, objectFit: 'contain', background: palette.inputBg }}
      onError={() => {
        setFailed((prev) => [...prev, src]);
      }}
      title={connectorHost(url)}
    />
  );
}
