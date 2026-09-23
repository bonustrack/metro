import { type ReactNode } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Button } from './ui.js';
import { stationLabel } from '../api/attach.js';
import { StationIcon } from './StationIcon.js';

const ICON_SIZE = 22;
const ICON_GAP_EXTRA = 4;
const FULL_WIDTH = { alignSelf: 'stretch' } as const;

interface StationPickerProps {
  stations: string[];
  disabled: boolean;
  onPick: (station: string) => void;
}

export function StationPicker({ stations, disabled, onPick }: StationPickerProps): ReactNode {
  const dark = useKitScheme() === 'dark';
  return (
    <Col gap={10}>
      {stations.map((station) => (
        <Button
          key={station}
          size="lg"
          color="secondary"
          dark={dark}
          disabled={disabled}
          label={stationLabel(station)}
          icon={
            <Row padding={{ right: ICON_GAP_EXTRA }}>
              <StationIcon station={station} size={ICON_SIZE} />
            </Row>
          }
          style={FULL_WIDTH}
          onPress={() => {
            onPick(station);
          }}
        />
      ))}
    </Col>
  );
}
