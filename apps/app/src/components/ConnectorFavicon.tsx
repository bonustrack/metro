import { type ReactNode, useState } from 'react';
import { Image, Platform, View } from 'react-native';
import { SvgUri } from 'react-native-svg';
import { useKitPalette, useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Text } from '@stage-labs/kit/react-native/text';
import { brandSrc } from '@metro-labs/core/brands';
import { siteIconUrl } from '@metro-labs/client/api/icons';
import { location } from '@metro-labs/client/platform';

interface ConnectorFaviconProps {
  name: string;
  url: string;
  size: number;
  radius?: number;
}

const INSET = 0.7;

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
  const src = brandSrc(url, dark) ?? siteIconUrl(url);
  const blank = failed || src === '';
  const tile = {
    width: size,
    height: size,
    minWidth: size,
    borderRadius: radius,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    backgroundColor: palette.inputBg,
  } as const;
  return (
    <View style={tile}>
      {blank ? (
        <Text size="md" fontWeight="semibold" color="secondary">
          {(name.trim()[0] ?? '?').toUpperCase()}
        </Text>
      ) : (
        <Picture
          src={src}
          size={Math.round(size * INSET)}
          onError={() => {
            setFailed(true);
          }}
        />
      )}
    </View>
  );
}
