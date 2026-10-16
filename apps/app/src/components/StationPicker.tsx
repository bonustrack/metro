import { type ReactNode } from 'react';
import { STATION_FORMS, stationLabel } from '@metro-labs/client/api/attach';
import { StationIcon } from './StationIcon.js';
import { Rows } from './ui/Group.js';
import { Item } from './ui/Item.js';
import { ICON_SIZE } from './ui/sizes.js';

interface StationPickerProps {
  stations: string[];
  hrefOf: (station: string) => string;
}

const lineOf = (station: string): string | undefined => {
  const form = STATION_FORMS[station];
  if (form === undefined) return undefined;
  if (form.interactive) return `Sign in with ${form.provider ?? stationLabel(station)}`;
  return form.fields.length === 0 ? 'Metro makes the address for you' : 'Paste its details';
};

export function StationPicker({ stations, hrefOf }: StationPickerProps): ReactNode {
  return (
    <Rows>
      {stations.map((station) => (
        <Item key={station} title={stationLabel(station)} subtitle={lineOf(station)} leading={<StationIcon station={station} size={ICON_SIZE.lg} />} href={hrefOf(station)} />
      ))}
    </Rows>
  );
}
