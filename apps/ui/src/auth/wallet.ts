import { useSyncExternalStore } from 'react';
import { createWalletClient, custom, type EIP1193Provider, type TypedDataDefinition } from 'viem';
import { readRecentWallet } from './recent';
import { walletChoices, type WalletChoice } from './wallet-options';

export interface Connected {
  provider: EIP1193Provider;
  address: `0x${string}`;
  release: () => Promise<void>;
}

interface AnnounceDetail {
  info: { uuid: string; name: string; icon: string; rdns: string };
  provider: EIP1193Provider;
}

const APP_NAME = 'Metro';
const APP_DESCRIPTION = 'Chat bridge and connector relay for agents';
const RELEASE_GRACE_MS = 300;
const DEFAULT_WC_PROJECT_ID = 'e6454bd61aba40b786e866a69bd4c5c6';

const providers = new Map<string, EIP1193Provider>();
const listeners = new Set<() => void>();
let announced: WalletChoice[] = [];
let snapshot: WalletChoice[] | null = null;
let subscribed = false;

const projectId = (): string => {
  const configured = import.meta.env.VITE_WC_PROJECT_ID?.trim() ?? '';
  return configured === '' ? DEFAULT_WC_PROJECT_ID : configured;
};

function isProvider(value: unknown): value is EIP1193Provider {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { request?: unknown }).request === 'function'
  );
}

function browserWallet(): EIP1193Provider | null {
  const injected: unknown = (window as Window & { ethereum?: unknown }).ethereum;
  return isProvider(injected) ? injected : null;
}

function announce(event: Event): void {
  const detail = (event as CustomEvent<AnnounceDetail>).detail;
  providers.set(detail.info.rdns, detail.provider);
  announced = [
    ...announced.filter((c) => c.id !== detail.info.rdns),
    {
      id: detail.info.rdns,
      name: detail.info.name,
      icon: detail.info.icon,
      kind: 'injected',
      recent: false,
    },
  ];
  snapshot = null;
  for (const listener of listeners) listener();
}

function subscribeWallets(listener: () => void): () => void {
  listeners.add(listener);
  if (!subscribed) {
    subscribed = true;
    window.addEventListener('eip6963:announceProvider', announce);
  }
  window.dispatchEvent(new Event('eip6963:requestProvider'));
  return () => {
    listeners.delete(listener);
  };
}

function currentWallets(): WalletChoice[] {
  snapshot ??= walletChoices(
    announced,
    browserWallet() !== null,
    projectId(),
    readRecentWallet(),
  );
  return snapshot;
}

export function useWallets(): WalletChoice[] {
  return useSyncExternalStore(subscribeWallets, currentWallets);
}

async function addressOf(provider: EIP1193Provider): Promise<`0x${string}`> {
  const client = createWalletClient({ transport: custom(provider) });
  const known = await client.getAddresses().catch(() => []);
  const [address] = known.length > 0 ? known : await client.requestAddresses();
  if (address === undefined) throw new Error('The wallet returned no account.');
  return address;
}

const noRelease = (): Promise<void> => Promise.resolve();

async function connectInjected(choice: WalletChoice): Promise<Connected> {
  const provider = providers.get(choice.id) ?? browserWallet();
  if (provider === null) throw new Error('That wallet is no longer available.');
  return { provider, address: await addressOf(provider), release: noRelease };
}

async function connectCoinbase(): Promise<Connected> {
  const { createCoinbaseWalletSDK } = await import('@coinbase/wallet-sdk');
  const sdk = createCoinbaseWalletSDK({
    appName: APP_NAME,
    appLogoUrl: `${window.location.origin}/favicon.svg`,
    appChainIds: [1],
  });
  const raw: unknown = sdk.getProvider();
  if (!isProvider(raw)) throw new Error('Coinbase Wallet returned no provider.');
  const release = async (): Promise<void> => {
    const closable = raw as { disconnect?: () => Promise<void> };
    await closable.disconnect?.().catch(() => undefined);
  };
  return { provider: raw, address: await addressOf(raw), release };
}

type AppKitModal = Awaited<ReturnType<typeof loadAppKit>>;

async function loadAppKit(dark: boolean): Promise<import('@reown/appkit').AppKit> {
  const { createAppKit } = await import('@reown/appkit');
  const { arbitrum, base, gnosis, mainnet, optimism, polygon } = await import(
    '@reown/appkit/networks'
  );
  return createAppKit({
    networks: [mainnet, optimism, base, arbitrum, polygon, gnosis],
    projectId: projectId(),
    themeMode: dark ? 'dark' : 'light',
    allWallets: 'ONLY_MOBILE',
    metadata: {
      name: APP_NAME,
      description: APP_DESCRIPTION,
      url: window.location.origin,
      icons: [`${window.location.origin}/favicon.svg`],
    },
  });
}

let appKit: Promise<AppKitModal> | null = null;

function awaitProvider(modal: AppKitModal): Promise<EIP1193Provider> {
  return new Promise((resolve, reject) => {
    const stopEvents = modal.subscribeEvents((event) => {
      if (event.data.event === 'MODAL_CLOSE') {
        stopEvents();
        stopProviders();
        reject(new Error('The wallet dialog was closed before connecting.'));
      }
    });
    const stopProviders = modal.subscribeProviders((state) => {
      const found: unknown = state.eip155;
      if (!isProvider(found)) return;
      stopEvents();
      stopProviders();
      resolve(found);
    });
  });
}

async function connectWalletConnect(dark: boolean): Promise<Connected> {
  appKit ??= loadAppKit(dark);
  const modal = await appKit;
  modal.setThemeMode(dark ? 'dark' : 'light');
  await modal.disconnect().catch(() => undefined);
  await modal.open();
  const provider = await awaitProvider(modal);
  await modal.close();
  const release = async (): Promise<void> => {
    await new Promise((r) => setTimeout(r, RELEASE_GRACE_MS));
    await modal.disconnect().catch(() => undefined);
  };
  return { provider, address: await addressOf(provider), release };
}

export function connectWallet(choice: WalletChoice, dark: boolean): Promise<Connected> {
  if (choice.kind === 'walletconnect') return connectWalletConnect(dark);
  if (choice.kind === 'coinbase') return connectCoinbase();
  return connectInjected(choice);
}

const clientFor = (connected: Connected) =>
  createWalletClient({ account: connected.address, transport: custom(connected.provider) });

export function signWith(connected: Connected, message: string): Promise<`0x${string}`> {
  return clientFor(connected).signMessage({ message });
}

export function signTypedDataWith(connected: Connected, typedData: TypedDataDefinition): Promise<`0x${string}`> {
  return clientFor(connected).signTypedData(typedData);
}
