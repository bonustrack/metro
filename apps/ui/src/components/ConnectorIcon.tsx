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
  const boxStyle = {
    width: size,
    height: size,
    borderRadius: Math.round(size / 4),
    flex: `0 0 ${String(size)}px`,
    overflow: 'hidden' as const,
  };

  const placeholderStyle = {
    ...boxStyle,
    background: palette.inputBg,
    display: 'flex' as const,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
  };
  const imageStyle = {
    ...boxStyle,
    objectFit: 'contain' as const,
    background: palette.inputBg,
  };

  if (src === undefined)
    return (
      <div style={placeholderStyle}>
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
      style={imageStyle}
      onError={() => {
        setFailed((prev) => [...prev, src]);
      }}
      title={connectorHost(url)}
    />
  );
}
