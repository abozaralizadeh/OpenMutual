import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  type Account,
  type Abi,
  type Address,
  type PublicClient,
} from 'viem';
import { mnemonicToAccount } from 'viem/accounts';

export const LOCAL_CHAIN_ID = 31337;

/** Anvil's default phrase. It's public and printed by anvil itself, so it can only ever hold test money. */
const PUBLIC_TEST_MNEMONIC = 'test test test test test test test test test test test junk';

export const ROLES = {
  deployer: 0,
  quoter: 1,
  reporter0: 2,
  reporter1: 3,
  reporter2: 4,
  guardian: 5,
  verifier: 6,
  signer0: 7,
  signer1: 8,
  signer2: 9,
} as const;

export type Role = keyof typeof ROLES;

export function rpcUrl(): string {
  return process.env.RPC_URL ?? 'http://127.0.0.1:8545';
}

/** The one guard that keeps this project off every public network. */
export function assertLocalUrl(url: string) {
  const host = new URL(url).hostname;
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '[::1]') {
    throw new Error(`Refusing to use ${host}. This project only runs on a local chain.`);
  }
}

export async function assertLocalChain(client: Pick<PublicClient, 'getChainId'>) {
  const id = await client.getChainId();
  if (id !== LOCAL_CHAIN_ID) throw new Error(`Refusing chain ${id}. This project only runs on the local chain ${LOCAL_CHAIN_ID}.`);
}

export const localChain = defineChain({
  id: LOCAL_CHAIN_ID,
  name: 'Local test chain',
  nativeCurrency: { name: 'Test Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [rpcUrl()] } },
});

export function publicClient(url = rpcUrl()) {
  assertLocalUrl(url);
  return createPublicClient({ chain: localChain, transport: http(url), cacheTime: 0, pollingInterval: 100 });
}

export function walletClient(account: Account, url = rpcUrl()) {
  assertLocalUrl(url);
  return createWalletClient({ account, chain: localChain, transport: http(url) });
}

export function accountAt(index: number) {
  return mnemonicToAccount(process.env.LOCAL_MNEMONIC ?? PUBLIC_TEST_MNEMONIC, { addressIndex: index });
}

export function roleAccount(role: Role) {
  return accountAt(ROLES[role]);
}

export class ChainActionError extends Error {}

const FRIENDLY_ERRORS: Record<string, string> = {
  NotEnoughFreeCapital: "The pool doesn't have enough free money for this cover right now.",
  OverEventLimit: 'This event has reached its limit of cover.',
  SalesClosed: 'Sales for this event have closed.',
  QuoteExpired: 'This price has expired. Get a new one.',
  Paused: 'New covers are paused right now.',
  EnforcedPause: 'This is paused right now.',
  ERC4626ExceededMaxDeposit: "The pool is paused or full, so it can't take this deposit.",
  ERC20InsufficientBalance: "You don't have enough test money for this.",
  ERC20InsufficientAllowance: "This needs approval for more test money.",
  AlreadyVoted: "You've already voted on this.",
  NotEligible: 'Only people who were members before this vote opened can vote.',
  OwnClaim: "You can't vote on your own claim.",
  NotMember: 'Only members can do this.',
  NotAllowed: "Members can't change that setting.",
  VotingClosed: 'This vote has closed.',
  VotingOpen: 'This vote is still open.',
  DidNotPass: "This proposal didn't pass.",
  ClaimWindowClosed: 'The time for claims on this cover has ended.',
  NotActive: "This cover isn't active.",
  NotReady: "This isn't ready yet.",
};

/** Turns a contract revert into a sentence a person can read. */
export function friendlyError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  for (const [name, message] of Object.entries(FRIENDLY_ERRORS)) {
    if (text.includes(name)) return message;
  }
  return 'That action failed. Try again in a moment.';
}

export interface Write {
  address: Address;
  abi: Abi | readonly unknown[];
  functionName: string;
  args?: readonly unknown[];
}

/** Simulates, sends and waits. Simulating first gives a clear error and spends nothing on failure. */
export async function send(client: PublicClient, account: Account, write: Write) {
  const { request, result } = await client.simulateContract({ ...write, account } as never) as unknown as {
    request: unknown;
    result: unknown;
  };
  const hash = await walletClient(account).writeContract(request as never);
  // The local chain mines each transaction straight away, so the receipt is usually there already.
  const receipt = await client.getTransactionReceipt({ hash }).catch(() => client.waitForTransactionReceipt({ hash }));
  if (receipt.status !== 'success') throw new ChainActionError(`Transaction failed: ${write.functionName}`);
  return { hash, receipt, result };
}

// Local chain tools. These RPC methods only exist on a dev chain.

export async function chainNow(client: PublicClient): Promise<number> {
  const block = await client.getBlock({ blockTag: 'latest' });
  return Number(block.timestamp);
}

async function rpc(client: PublicClient, method: string, params: unknown[]) {
  await assertLocalChain(client);
  return client.request({ method, params } as never);
}

/** Mines an empty block so the chain clock keeps up with real time. */
export async function mine(client: PublicClient) {
  await rpc(client, 'evm_mine', []);
}

export async function skipTime(client: PublicClient, seconds: number) {
  await rpc(client, 'evm_increaseTime', [seconds]);
  await rpc(client, 'evm_mine', []);
}

export async function giveGas(client: PublicClient, address: Address) {
  await rpc(client, 'anvil_setBalance', [address, '0x56BC75E2D63100000']);
}
