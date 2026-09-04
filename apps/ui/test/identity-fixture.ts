import { identityFrom, storeIdentity, type Identity } from '../src/auth/identity';

export const TEST_WALLET = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8';
export const TEST_SIGNATURE =
  '0x436c286f6cddaa9f185c67520ecbd8b8cbc29db5384dd8a16bf9fb36d960ed656609521b2432028b53b2b68bfdcd918284348e0c69428dd6f18779fd06f03b7d1c' as const;
export const TEST_IDENTITY_ADDRESS = '0xfbd1aaf49dac784e5947725571bf20db7752f3d7';

export async function installTestIdentity(): Promise<Identity> {
  const identity = await identityFrom(TEST_WALLET, TEST_SIGNATURE);
  storeIdentity(identity);
  return identity;
}
