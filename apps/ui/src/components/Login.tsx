import { type ReactNode, useState } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { Pressable } from '@stage-labs/kit/react-native/pressable';
import {
  useKitPalette,
  useKitScheme,
} from '@stage-labs/kit/react-native/theme-context';
import { BLOCK_RADIUS_DEFAULT } from '@stage-labs/kit/tokens';
import { Text } from './ui';
import { GROW } from '../theme';
import { MetroLogo } from './MetroLogo';
import { PageTitle } from './PageTitle';
import { Pill } from './Pill';
import { Spinner } from './Spinner';
import { storeRecentWallet } from '../auth/recent';
import { connectWallet, signTypedDataWith, useWallets } from '../auth/wallet';
import { identityFrom, storeIdentity, type Identity } from '../auth/identity';
import { ENCRYPTION_KEY_TYPED_DATA } from '../vault/crypto';
import { daemonHost, routedDaemon } from '../auth/daemon';
import { type WalletChoice } from '../auth/wallet-options';

const CARD_WIDTH = 400;
const ICON_SIZE = 28;
const ROW_HEIGHT = 52;
const ROW_PAD_X = 14;
const ROW_GAP = 10;
const SPINNER_SIZE = 20;
const NO_BROWSER_WALLET =
  'No browser wallet found. WalletConnect and Coinbase Wallet reach the wallet app on your phone; MetaMask or Rabby in this browser would show up here too.';

const ONE_SIGNATURE =
  'One signature signs you in everywhere: it unlocks your daemons and derives the key that seals your agents on metro.box. It stays in this browser, so you are not asked again.';

export async function signInTo(choice: WalletChoice, dark: boolean): Promise<Identity> {
  const connected = await connectWallet(choice, dark);
  try {
    const signature = await signTypedDataWith(connected, ENCRYPTION_KEY_TYPED_DATA);
    const identity = await identityFrom(connected.address, signature);
    storeIdentity(identity);
    storeRecentWallet(choice.id);
    return identity;
  } finally {
    await connected.release();
  }
}

function WalletIcon({ src }: { src: string | null }): ReactNode {
  if (src === null) return <Row width={ICON_SIZE} height={ICON_SIZE} />;
  return (
    <img
      src={src}
      width={ICON_SIZE}
      height={ICON_SIZE}
      className="wallet-icon"
      alt=""
    />
  );
}

export function WalletRow({
  choice,
  busy,
  disabled,
  last,
  onPress,
}: {
  choice: WalletChoice;
  busy: boolean;
  disabled: boolean;
  last: boolean;
  onPress: () => void;
}): ReactNode {
  const palette = useKitPalette();
  const trailing = busy ? (
    <Spinner size={SPINNER_SIZE} color={palette.link} />
  ) : choice.recent ? (
    <Pill label="Recent" variant="primary" />
  ) : choice.kind === 'injected' ? (
    <Pill label="Detected" />
  ) : null;
  return (
    <Pressable pressedOpacity={0.6} disabled={disabled} onPress={onPress}>
      <Row
        align="center"
        gap={ROW_GAP}
        height={ROW_HEIGHT}
        padding={{ x: ROW_PAD_X }}
        border={last ? undefined : { bottom: { width: 1, color: palette.border } }}
      >
        <WalletIcon src={choice.icon} />
        <Text size="md" numberOfLines={1} style={GROW}>
          {choice.name}
        </Text>
        {trailing}
      </Row>
    </Pressable>
  );
}

interface LoginProps {
  onSignedIn: () => void;
}

export function Login({ onSignedIn }: LoginProps): ReactNode {
  const dark = useKitScheme() === 'dark';
  const palette = useKitPalette();
  const wallets = useWallets();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const side = { width: 1, color: palette.border };

  const pick = (choice: WalletChoice): void => {
    if (busy !== null) return;
    setBusy(choice.id);
    setError(null);
    signInTo(choice, dark)
      .then(() => {
        onSignedIn();
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Sign-in failed.');
      })
      .finally(() => {
        setBusy(null);
      });
  };

  return (
    <Row justify="center" align="center" flex={1} padding={24}>
      <Col
        gap={20}
        width="100%"
        maxWidth={CARD_WIDTH}
        padding={24}
        radius={BLOCK_RADIUS_DEFAULT}
        border={{ top: side, right: side, bottom: side, left: side }}
      >
        <Row justify="center">
          <MetroLogo size={48} color={palette.link} />
        </Row>
        <Row justify="center">
          <PageTitle>Sign in</PageTitle>
        </Row>
        {routedDaemon() === null ? null : (
          <Row justify="center">
            <Text size="sm" role="secondary">
              then on to {daemonHost(routedDaemon() ?? '')}
            </Text>
          </Row>
        )}
        <Text size="sm" role="secondary">
          {ONE_SIGNATURE}
        </Text>
        {wallets.some((w) => w.kind === 'injected') ? null : (
          <Text size="sm" role="secondary">
            {NO_BROWSER_WALLET}
          </Text>
        )}
        <Col
          radius={BLOCK_RADIUS_DEFAULT}
          border={{ top: side, right: side, bottom: side, left: side }}
        >
          {wallets.map((choice, index) => (
            <WalletRow
              key={choice.id}
              choice={choice}
              busy={busy === choice.id}
              disabled={busy !== null}
              last={index === wallets.length - 1}
              onPress={() => {
                pick(choice);
              }}
            />
          ))}
        </Col>
        {error !== null ? (
          <Text size="sm" role="danger">
            {error}
          </Text>
        ) : null}
      </Col>
    </Row>
  );
}
