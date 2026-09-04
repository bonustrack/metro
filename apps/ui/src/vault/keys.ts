import { connectWallet, signTypedDataWith } from '../auth/wallet';
import { type WalletChoice } from '../auth/wallet-options';
import { storeRecentWallet } from '../auth/recent';
import { shortAddress } from '../api/address';
import { ENCRYPTION_KEY_TYPED_DATA, walletKeys, type WalletKeys } from './crypto';

export async function keysWith(choice: WalletChoice, dark: boolean, owner: string): Promise<WalletKeys> {
  const connected = await connectWallet(choice, dark);
  try {
    if (connected.address.toLowerCase() !== owner.toLowerCase())
      throw new Error(`Sign with the wallet that owns this machine, ${shortAddress(owner)}.`);
    const signature = await signTypedDataWith(connected, ENCRYPTION_KEY_TYPED_DATA);
    const keys = await walletKeys(connected.address, signature);
    storeRecentWallet(choice.id);
    return keys;
  } finally {
    await connected.release();
  }
}
