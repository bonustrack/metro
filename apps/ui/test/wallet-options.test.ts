import { describe, expect, test } from 'bun:test';
import { BROWSER_WALLET, walletChoices, type WalletChoice } from '../src/auth/wallet-options';

const METAMASK: WalletChoice = {
  id: 'io.metamask',
  name: 'MetaMask',
  icon: 'data:image/svg+xml;base64,PHN2Zy8+',
  kind: 'injected',
  recent: false,
};

const PHANTOM: WalletChoice = { ...METAMASK, id: 'app.phantom', name: 'Phantom' };

const ids = (choices: WalletChoice[]): string[] => choices.map((c) => c.id);

describe('which wallets the login page offers', () => {
  test('announced wallets come first, then WalletConnect, then Coinbase', () => {
    expect(ids(walletChoices([METAMASK], true, 'project', null))).toEqual([
      'io.metamask',
      'walletconnect',
      'coinbase',
    ]);
  });

  test('a bare window.ethereum stands in when nothing announced itself', () => {
    expect(walletChoices([], true, 'project', null)[0]).toEqual(BROWSER_WALLET);
  });

  test('without any browser wallet the remote options are still there', () => {
    expect(ids(walletChoices([], false, 'project', null))).toEqual([
      'walletconnect',
      'coinbase',
    ]);
  });

  test('WalletConnect needs a project id, Coinbase does not', () => {
    expect(ids(walletChoices([METAMASK], true, '', null))).toEqual(['io.metamask', 'coinbase']);
    expect(ids(walletChoices([], false, '   ', null))).toEqual(['coinbase']);
  });

  test('the last-used wallet moves to the top and is the only one flagged recent', () => {
    const choices = walletChoices([METAMASK, PHANTOM], true, 'project', 'app.phantom');
    expect(ids(choices)).toEqual(['app.phantom', 'io.metamask', 'walletconnect', 'coinbase']);
    expect(choices.map((c) => c.recent)).toEqual([true, false, false, false]);
    const remote = walletChoices([METAMASK], true, 'project', 'walletconnect');
    expect(ids(remote)).toEqual(['walletconnect', 'io.metamask', 'coinbase']);
  });

  test('a remembered wallet that is no longer present changes nothing', () => {
    const choices = walletChoices([METAMASK], true, 'project', 'io.gone');
    expect(ids(choices)).toEqual(['io.metamask', 'walletconnect', 'coinbase']);
    expect(choices.some((c) => c.recent)).toBe(false);
  });

  test('the remote options carry an icon', () => {
    for (const choice of walletChoices([], false, 'project', null))
      expect(choice.icon?.startsWith('data:image/')).toBe(true);
  });
});
