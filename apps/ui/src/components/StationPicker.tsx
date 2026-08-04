import { type ReactNode } from 'react';
import { Row } from '@stage-labs/kit/react-native/box';
import { Button } from './ui';
import {
  useKitPalette,
  useKitScheme,
} from '@stage-labs/kit/react-native/theme-context';
import { stationLabel } from '../api/attach';
import { StationIcon } from './StationIcon';

interface StationPickerProps {
  stations: string[];
  picked: string;
  disabled: boolean;
  onPick: (station: string) => void;
}

export function StationPicker({
  stations,
  picked,
  disabled,
  onPick,
}: StationPickerProps): ReactNode {
  const dark = useKitScheme() === 'dark';
  const palette = useKitPalette();
  return (
    <Row gap={8} wrap>
      {stations.map((station) => (
        <Button
          key={station}
          size="sm"
          dark={dark}
          disabled={disabled}
          color={station === picked ? 'primary' : 'secondary'}
          variant={station === picked ? 'solid' : 'soft'}
          onPress={() => {
            onPick(station);
          }}
          label={stationLabel(station)}
          icon={
            <StationIcon
              station={station}
              size={14}
              color={station === picked ? palette.bg : palette.text}
            />
          }
        />
      ))}
    </Row>
  );
}
