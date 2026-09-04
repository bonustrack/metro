import { type ReactNode } from 'react';
import { Col } from '@stage-labs/kit/react-native/box';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { BLOCK_RADIUS_DEFAULT } from '@stage-labs/kit/tokens';
import { Text } from './ui';
import { WalletRow } from './Login';
import { useWallets } from '../auth/wallet';
import { type WalletChoice } from '../auth/wallet-options';

interface WalletListProps {
  title: string;
  busy: string | null;
  onPick: (choice: WalletChoice) => void;
}

export function WalletList({ title, busy, onPick }: WalletListProps): ReactNode {
  const palette = useKitPalette();
  const wallets = useWallets();
  const side = { width: 1, color: palette.border };
  return (
    <Col gap={10}>
      <Text size="sm" role="secondary">
        {title}
      </Text>
      <Col radius={BLOCK_RADIUS_DEFAULT} border={{ top: side, right: side, bottom: side, left: side }}>
        {wallets.map((choice, index) => (
          <WalletRow
            key={choice.id}
            choice={choice}
            busy={busy === `sign:${choice.id}`}
            disabled={busy !== null}
            last={index === wallets.length - 1}
            onPress={() => {
              onPick(choice);
            }}
          />
        ))}
      </Col>
    </Col>
  );
}
