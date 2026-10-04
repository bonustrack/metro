import { type ReactNode, useState } from 'react';
import { Image, Platform, View } from 'react-native';
import { SvgUri } from 'react-native-svg';
import { useKitPalette, useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Text } from '@stage-labs/kit/react-native/text';
import { faviconUrl } from '@metro-labs/client/api/favicon';
import { brandSrc } from '@metro-labs/client/api/brands';
import { location } from '@metro-labs/client/platform';

const REQUEST_SIZE = 32;

interface ConnectorFaviconProps {
  name: string;
  url: string;
  size: number;
  radius?: number;
}

const absolute = (src: string): string => (src.startsWith('/') ? `${location().origin()}${src}` : src);

function Picture({ src, size, onError }: { src: string; size: number; onError: () => void }): ReactNode {
  const box = { width: size, height: size };
  if (Platform.OS !== 'web' && src.endsWith('.svg')) return <SvgUri uri={absolute(src)} width={size} height={size} onError={onError} />;
  return <Image source={{ uri: absolute(src) }} style={box} resizeMode="contain" onError={onError} />;
}

export function ConnectorFavicon({ name, url, size, radius = Math.round(size / 4) }: ConnectorFaviconProps): ReactNode {
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
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    backgroundColor: blank ? palette.inputBg : 'transparent',
  } as const;
  return (
    <View style={tile}>
      {blank ? (
        <Text size={size >= 28 ? '2xs' : '3xs'} weight="semibold" role="secondary">
          {(name.trim()[0] ?? '?').toUpperCase()}
        </Text>
      ) : (
        <Picture
          src={src}
          size={size}
          onError={() => {
            setFailed(true);
          }}
        />
      )}
    </View>
  );
}
