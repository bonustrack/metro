import { useState, type ReactNode } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import {
  useKitPalette,
  useKitScheme,
} from '@stage-labs/kit/react-native/theme-context';
import { Text, Input } from './ui';
import { matchStations, stationLabel } from '../api/attach';
import { StationIcon } from './StationIcon';

const ICON_SIZE = 20;

interface StationPickerProps {
  stations: string[];
  disabled: boolean;
  onPick: (station: string) => void;
}

function Option({
  station,
  disabled,
  onPick,
}: {
  station: string;
  disabled: boolean;
  onPick: (station: string) => void;
}): ReactNode {
  const palette = useKitPalette();
  return (
    <button
      type="button"
      className="picker-option"
      disabled={disabled}
      onClick={() => {
        onPick(station);
      }}
    >
      <StationIcon station={station} size={ICON_SIZE} color={palette.link} />
      <Text size="lg" weight="semibold">{stationLabel(station)}</Text>
    </button>
  );
}

export function StationPicker({
  stations,
  disabled,
  onPick,
}: StationPickerProps): ReactNode {
  const dark = useKitScheme() === 'dark';
  const [query, setQuery] = useState('');
  const shown = matchStations(stations, query);

  return (
    <Col gap={8}>
      <Input
        name="station-search"
        value={query}
        placeholder="Search stations"
        disabled={disabled}
        dark={dark}
        onChangeText={setQuery}
        onSubmit={() => {
          const only = shown[0];
          if (only !== undefined) onPick(only);
        }}
        style={{ flexGrow: 1, minWidth: 0 }}
      />
      {shown.length === 0 ? (
        <Text size="sm" role="secondary">
          No station matches “{query.trim()}”.
        </Text>
      ) : (
        <div className="picker-menu">
          {shown.map((station) => (
            <Option
              key={station}
              station={station}
              disabled={disabled}
              onPick={onPick}
            />
          ))}
        </div>
      )}
      {query.trim() === '' && stations.length > shown.length ? (
        <Row gap={4}>
          <Text size="sm" role="secondary">
            Type to search {String(stations.length - shown.length)} more.
          </Text>
        </Row>
      ) : null}
    </Col>
  );
}
