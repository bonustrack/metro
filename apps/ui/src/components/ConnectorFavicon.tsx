import { type ReactNode, useState } from 'react';
import { colors } from '@stage-labs/kit/tokens';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { Text } from './ui';
import { faviconUrl } from '../api/favicon';

const REQUEST_SIZE = 32;

interface ConnectorFaviconProps {
  name: string;
  url: string;
  size: number;
}

export function ConnectorFavicon({
  name,
  url,
  size,
}: ConnectorFaviconProps): ReactNode {
  const palette = useKitPalette();
  const [failed, setFailed] = useState(false);
  const src = faviconUrl(url, REQUEST_SIZE);
  const blank = failed || src === '';
  const tile = {
    width: size,
    height: size,
    minWidth: size,
    borderRadius: Math.round(size / 4),
    display: 'flex' as const,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
    overflow: 'hidden' as const,
    background: blank ? palette.inputBg : colors['bg-light'],
  };
  if (blank)
    return (
      <div style={tile}>
        <Text size={size >= 28 ? 'sm' : 'xs'} weight="semibold" role="secondary">
          {(name.trim()[0] ?? '?').toUpperCase()}
        </Text>
      </div>
    );
  const image = {
    width: size,
    height: size,
    objectFit: 'contain' as const,
  };
  return (
    <div style={tile}>
      <img
        src={src}
        alt=""
        width={size}
        height={size}
        style={image}
        loading="lazy"
        referrerPolicy="no-referrer"
        onError={() => {
          setFailed(true);
        }}
      />
    </div>
  );
}
