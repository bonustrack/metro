import { type ReactNode, useState } from 'react';
import { useKitPalette, useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Text } from './ui.js';
import { faviconUrl } from '../api/favicon.js';
import { brandSrc } from '../api/brands.js';

const REQUEST_SIZE = 32;

interface ConnectorFaviconProps {
  name: string;
  url: string;
  size: number;
  radius?: number;
}

export function ConnectorFavicon({
  name,
  url,
  size,
  radius = Math.round(size / 4),
}: ConnectorFaviconProps): ReactNode {
  const palette = useKitPalette();
  const dark = useKitScheme() === 'dark';
  const [failed, setFailed] = useState(false);
  const brand = brandSrc(url, dark);
  const src = brand ?? faviconUrl(url, REQUEST_SIZE);
  const blank = failed || src === '';
  const tile = {
    width: size,
    height: size,
    minWidth: size,
    borderRadius: brand === null ? radius : 0,
    display: 'flex' as const,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
    overflow: 'hidden' as const,
    background: blank ? palette.inputBg : 'transparent',
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
