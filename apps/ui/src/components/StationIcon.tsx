import { type ReactNode } from 'react';
import { ConnectorFavicon } from './ConnectorFavicon';

const STATION_SITES: Record<string, string> = {
  xmtp: 'https://xmtp.org',
  'telegram-bot': 'https://telegram.org',
  telegram: 'https://telegram.org',
  'discord-bot': 'https://discord.com',
  whatsapp: 'https://whatsapp.com',
};

export interface StationIconProps {
  station: string;
  size?: number;
}

export function StationIcon({ station, size = 20 }: StationIconProps): ReactNode {
  return <ConnectorFavicon name={station} url={STATION_SITES[station] ?? ''} size={size} />;
}
