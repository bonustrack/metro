import { COINBASE_ICON, WALLETCONNECT_ICON } from './wallet-icons';

export type WalletKind = 'injected' | 'walletconnect' | 'coinbase';

export interface WalletChoice {
  id: string;
  name: string;
  icon: string | null;
  kind: WalletKind;
  recent: boolean;
}

export const BROWSER_WALLET: WalletChoice = {
  id: 'injected',
  name: 'Browser wallet',
  icon: null,
  kind: 'injected',
  recent: false,
};

const WALLETCONNECT: WalletChoice = {
  id: 'walletconnect',
  name: 'WalletConnect',
  icon: WALLETCONNECT_ICON,
  kind: 'walletconnect',
  recent: false,
};

const COINBASE: WalletChoice = {
  id: 'coinbase',
  name: 'Coinbase Wallet',
  icon: COINBASE_ICON,
  kind: 'coinbase',
  recent: false,
};

export function walletChoices(
  announced: WalletChoice[],
  hasBrowserWallet: boolean,
  walletConnectProjectId: string,
  recentId: string | null,
): WalletChoice[] {
  const injected =
    announced.length > 0 ? announced : hasBrowserWallet ? [BROWSER_WALLET] : [];
  const remote =
    walletConnectProjectId.trim() === '' ? [COINBASE] : [WALLETCONNECT, COINBASE];
  const all = [...injected, ...remote].map((choice) => ({
    ...choice,
    recent: choice.id === recentId,
  }));
  return [...all.filter((c) => c.recent), ...all.filter((c) => !c.recent)];
}
