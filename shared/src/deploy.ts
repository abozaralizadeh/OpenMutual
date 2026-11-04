import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { keccak256, toBytes, toFunctionSelector, type Abi, type Address, type Hex, type PublicClient } from 'viem';
import { assertLocalChain, roleAccount, send, walletClient, type Role } from './chain';
import { loadDecisions, type ClaimSettings, type Decisions } from './config';
import { CoverBookAbi, MutualPoolAbi, ResultOracleAbi, TestUSDAbi, TimelockControllerAbi } from './generated/abis';
import { dataDir, projectRoot, type ContractName } from './paths';

export interface Addresses {
  usd: Address;
  pool: Address;
  oracle: Address;
  book: Address;
  members: Address;
  review: Address;
  ladder: Address;
  governor: Address;
  multisig: Address;
  timelock: Address;
}

export const DAY = 86_400;
export const USD = 1_000_000n;

export function usdToUnits(usd: number): bigint {
  return BigInt(Math.round(usd * 1_000_000));
}

function artifact(name: ContractName): { abi: Abi; bytecode: Hex } {
  const json = JSON.parse(readFileSync(join(projectRoot(), 'contracts/out', `${name}.sol`, `${name}.json`), 'utf8'));
  return { abi: json.abi, bytecode: json.bytecode.object };
}

async function create(client: PublicClient, name: ContractName, args: unknown[]): Promise<Address> {
  const { abi, bytecode } = artifact(name);
  const hash = await walletClient(roleAccount('deployer')).deployContract({ abi, bytecode, args } as never);
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (!receipt.contractAddress) throw new Error(`Deploying ${name} failed`);
  return receipt.contractAddress;
}

/** The ladder's settings as the contract takes them, from config/decisions.json. */
export function ladderSettings(claims: ClaimSettings) {
  return {
    panelSize: claims.panelSize,
    minMakers: claims.minMakers,
    minConfidence: claims.minConfidence,
    jurySize: claims.jurySize,
    juryQuorum: claims.juryQuorum,
    appealJurySize: claims.appealJurySize,
    appealQuorum: claims.appealQuorum,
    commitTime: claims.commitHours * 3600,
    revealTime: claims.revealHours * 3600,
    challengeTime: claims.challengeHours * 3600,
    appealTime: claims.appealHours * 3600,
    testWindow: claims.testWindowMinutes * 60,
    assessorBond: usdToUnits(claims.assessorBondUsd),
    jurorBond: usdToUnits(claims.jurorBondUsd),
    challengeBond: usdToUnits(claims.challengeBondUsd),
    appealBond: usdToUnits(claims.appealBondUsd),
  };
}

export async function deployAll(client: PublicClient, decisions: Decisions = loadDecisions()): Promise<Addresses> {
  await assertLocalChain(client);
  const deployer = roleAccount('deployer');
  const account = (role: Role) => roleAccount(role).address;
  const { pool: poolSettings, results, team, voting, claims } = decisions;

  const usd = await create(client, 'TestUSD', []);
  const timelock = await create(client, 'TimelockController', [
    team.changeDelayHours * 3600,
    [],
    ['0x0000000000000000000000000000000000000000'],
    deployer.address,
  ]);
  const pool = await create(client, 'MutualPool', [
    usd,
    deployer.address,
    account('guardian'),
    usdToUnits(poolSettings.capUsd),
    poolSettings.withdrawalWaitDays * DAY,
    poolSettings.memberRebateBps,
  ]);
  const oracle = await create(client, 'ResultOracle', [deployer.address, account('guardian'), results.quorum, results.challengeWindowMinutes * 60]);
  const book = await create(client, 'CoverBook', [pool, oracle, deployer.address, account('quoter')]);
  const members = await create(client, 'Membership', [deployer.address, account('verifier')]);
  const review = await create(client, 'ClaimReview', [book, members, voting.periodDays * DAY, voting.quorumBps, voting.minVotes]);
  const ladder = await create(client, 'ClaimLadder', [book, members, account('auditor'), ladderSettings(claims)]);

  // What members may change by vote. Anything not listed here stays with the team.
  const allowed: [Address, string][] = [
    [pool, 'setMemberRebateBps(uint256)'],
    [pool, 'setPoolCap(uint256)'],
    [pool, 'setWithdrawalWait(uint256)'],
  ];
  const governor = await create(client, 'MemberGovernor', [
    members,
    timelock,
    voting.periodDays * DAY,
    voting.quorumBps,
    voting.minVotes,
    allowed.map(([target]) => target),
    allowed.map(([, signature]) => toFunctionSelector(`function ${signature}`)),
  ]);
  const multisig = await create(client, 'TeamMultisig', [[account('signer0'), account('signer1'), account('signer2')], team.required]);

  const call = (address: Address, abi: Abi | readonly unknown[], functionName: string, args: readonly unknown[]) =>
    send(client, deployer, { address, abi, functionName, args });

  await call(pool, MutualPoolAbi, 'setCoverBook', [book]);
  await call(oracle, ResultOracleAbi, 'setRegistrar', [book]);
  for (const role of ['reporter0', 'reporter1', 'reporter2'] as const) {
    await call(oracle, ResultOracleAbi, 'setReporter', [account(role), true]);
  }
  // Both are deployed so either can be tried. The book sends claims to the one the settings pick.
  await call(book, CoverBookAbi, 'setClaimReview', [claims.mode === 'vote' ? review : ladder]);
  for (const product of decisions.products) {
    await call(book, CoverBookAbi, 'addProduct', [
      {
        active: true,
        kind: product.kind === 'automatic' ? 0 : 1,
        trigger: product.trigger,
        salesCutoff: product.salesCutoffHours * 3600,
        resultDeadline: product.resultDeadlineDays * DAY,
        eventLimitBps: product.eventLimitBps,
        maxPayout: usdToUnits(product.maxPayoutUsd),
      },
    ]);
  }

  // Starter money, so the pool can sell cover from the first minute.
  const starter = usdToUnits(poolSettings.starterMoneyUsd);
  if (starter > 0n) {
    const perFaucet = 10_000n * USD;
    for (let minted = 0n; minted < starter; minted += perFaucet) {
      await call(usd, TestUSDAbi, 'faucet', [deployer.address]);
    }
    await call(usd, TestUSDAbi, 'approve', [pool, starter]);
    await call(pool, MutualPoolAbi, 'deposit', [starter, deployer.address]);
  }

  // Hand everything to the timelock, so from here on no single key can change a rule.
  const proposer = keccak256(toBytes('PROPOSER_ROLE'));
  await call(timelock, TimelockControllerAbi, 'grantRole', [proposer, governor]);
  await call(timelock, TimelockControllerAbi, 'grantRole', [proposer, multisig]);
  for (const owned of [pool, oracle, book, members]) {
    await call(owned, MutualPoolAbi, 'transferOwnership', [timelock]);
  }
  await call(timelock, TimelockControllerAbi, 'renounceRole', [`0x${'00'.repeat(32)}`, deployer.address]);

  return { usd, pool, oracle, book, members, review, ladder, governor, multisig, timelock };
}

export function deploymentFile() {
  return join(dataDir(), 'deployment.json');
}

export function saveDeployment(addresses: Addresses) {
  writeFileSync(deploymentFile(), `${JSON.stringify(addresses, null, 2)}\n`);
}

export function loadDeployment(): Addresses {
  try {
    return JSON.parse(readFileSync(deploymentFile(), 'utf8'));
  } catch {
    throw new Error('No local deployment found. Start the chain and run npm run deploy.');
  }
}

