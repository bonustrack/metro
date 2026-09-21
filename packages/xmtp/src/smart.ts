import { createPublicClient, http, type Hex, type PublicClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';
import {
  createKernelAccount,
  createKernelAccountClient,
  createZeroDevPaymasterClient,
  getUserOperationGasPrice,
  type KernelAccountClient,
} from '@zerodev/sdk';
import { getEntryPoint, KERNEL_V3_1 } from '@zerodev/sdk/constants';
import { signerToEcdsaValidator } from '@zerodev/ecdsa-validator';

export const SMART_CHAIN_ID = 8453;
const STAGE_ZERODEV_PROJECT = 'c107f734-f7bb-48c1-a5d2-ceb3f70a42f6';
const ENTRY_POINT = getEntryPoint('0.7');

export const zerodevRpc = (): string =>
  `https://rpc.zerodev.app/api/v3/${process.env.METRO_ZERODEV_PROJECT ?? STAGE_ZERODEV_PROJECT}/chain/${String(SMART_CHAIN_ID)}`;

export interface SmartAccount {
  address: Hex;
  publicClient: PublicClient;
  client: () => KernelAccountClient;
  signMessage: (message: string) => Promise<Hex>;
  deployed: () => Promise<boolean>;
}

export async function smartAccountFor(privateKey: string, rpc = zerodevRpc()): Promise<SmartAccount> {
  const owner = privateKeyToAccount(privateKey as Hex);
  const publicClient = createPublicClient({ transport: http(rpc) });
  const validator = await signerToEcdsaValidator(publicClient, { signer: owner, entryPoint: ENTRY_POINT, kernelVersion: KERNEL_V3_1 });
  const account = await createKernelAccount(publicClient, { plugins: { sudo: validator }, entryPoint: ENTRY_POINT, kernelVersion: KERNEL_V3_1, index: 0n });
  const paymaster = createZeroDevPaymasterClient({ chain: base, transport: http(rpc) });
  const client = (): KernelAccountClient =>
    createKernelAccountClient({
      account,
      chain: base,
      bundlerTransport: http(rpc),
      client: publicClient,
      paymaster: { getPaymasterData: (userOperation) => paymaster.sponsorUserOperation({ userOperation }) },
      userOperation: { estimateFeesPerGas: ({ bundlerClient }) => getUserOperationGasPrice(bundlerClient) },
    });
  return {
    address: account.address,
    publicClient,
    client,
    signMessage: (message) => account.signMessage({ message }),
    deployed: async () => {
      const code = await publicClient.getCode({ address: account.address });
      return code !== undefined && code !== '0x';
    },
  };
}

export async function sendSponsored(smart: SmartAccount, to: Hex, data: Hex): Promise<Hex> {
  const client = smart.client();
  const hash = await client.sendTransaction({ to, data, value: 0n } as Parameters<typeof client.sendTransaction>[0]);
  const receipt = await smart.publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error(`the Base transaction ${hash} reverted`);
  return hash;
}

export async function ensureDeployed(smart: SmartAccount): Promise<boolean> {
  if (await smart.deployed()) return false;
  await sendSponsored(smart, smart.address, '0x');
  return true;
}
