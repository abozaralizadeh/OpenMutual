import { parseEventLogs, type Abi, type Address, type PublicClient } from 'viem';
import type { Db } from './db';
import { getState, setState } from './db';
import type { Addresses } from './deploy';
import { ClaimLadderAbi, ClaimReviewAbi, CoverBookAbi, MemberGovernorAbi, MembershipAbi, MutualPoolAbi, ResultOracleAbi } from './generated/abis';

const WATCHED: [keyof Addresses, Abi | readonly unknown[]][] = [
  ['pool', MutualPoolAbi],
  ['book', CoverBookAbi],
  ['oracle', ResultOracleAbi],
  ['members', MembershipAbi],
  ['review', ClaimReviewAbi],
  ['ladder', ClaimLadderAbi],
  ['governor', MemberGovernorAbi],
];

export const STATUS_NAMES = ['None', 'Active', 'ClaimOpen', 'PaidOut', 'Expired', 'Refunded'] as const;

function jsonable(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value, (_key, item) => (typeof item === 'bigint' ? item.toString() : item)));
}

/**
 * Copies chain events into the database, so pages are fast. Safe to run from any
 * process at any time. Everything here can be rebuilt from the chain.
 */
export async function syncEvents(db: Db, client: PublicClient, addresses: Addresses): Promise<number> {
  const latest = await client.getBlockNumber();
  const from = BigInt(getState(db, 'synced_block') ?? '-1') + 1n;
  if (from > latest) return 0;

  // Older local deployments have no ladder, so only watch what's there.
  const watched = WATCHED.filter(([name]) => Boolean(addresses[name]));
  const logs = await client.getLogs({
    address: watched.map(([name]) => addresses[name]) as Address[],
    fromBlock: from,
    toBlock: latest,
  });

  const times = new Map<bigint, number>();
  const timeOf = async (block: bigint) => {
    if (!times.has(block)) times.set(block, Number((await client.getBlock({ blockNumber: block })).timestamp));
    return times.get(block)!;
  };

  const insertEvent = db.prepare(
    'INSERT OR IGNORE INTO chain_events (tx, log_index, block, time, contract, name, args) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  let added = 0;
  for (const [name, abi] of watched) {
    const own = logs.filter((log) => log.address.toLowerCase() === addresses[name].toLowerCase());
    const parsed = parseEventLogs({ abi: abi as Abi, logs: own }) as unknown as {
      eventName: string;
      args: Record<string, unknown>;
      transactionHash: string;
      logIndex: number;
      blockNumber: bigint;
    }[];
    for (const log of parsed) {
      const time = await timeOf(log.blockNumber);
      const result = insertEvent.run(log.transactionHash, log.logIndex, Number(log.blockNumber), time, name, log.eventName, JSON.stringify(jsonable(log.args)));
      if (result.changes === 0) continue;
      added++;
      applyEvent(db, log.eventName, log.args, time);
    }
  }

  setState(db, 'synced_block', latest.toString());
  return added;
}

function applyEvent(db: Db, name: string, args: Record<string, unknown>, time: number) {
  if (name === 'CoverSold') {
    db.prepare(
      `INSERT OR IGNORE INTO covers (id, holder, product_id, event_key, ref, event_time, premium, payout, status, sold_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Active', ?)`,
    ).run(
      Number(args.coverId),
      String(args.holder).toLowerCase(),
      Number(args.productId),
      String(args.eventKey),
      String(args.ref),
      Number(args.eventTime),
      String(args.premium),
      String(args.payout),
      time,
    );
  } else if (name === 'CoverEnded') {
    db.prepare('UPDATE covers SET status = ?, paid = ?, ended_at = ? WHERE id = ?').run(
      STATUS_NAMES[Number(args.status)],
      String(args.paidToHolder),
      time,
      Number(args.coverId),
    );
  } else if (name === 'ClaimFiled') {
    db.prepare("UPDATE covers SET status = 'ClaimOpen' WHERE id = ?").run(Number(args.coverId));
  }
}

/** Adds one point to the share price history, at most once per simulated hour. */
export function recordSharePrice(db: Db, time: number, price: number, totalAssets: bigint) {
  const hour = Math.floor(time / 3600) * 3600;
  db.prepare(
    'INSERT INTO share_prices (time, price, total_assets) VALUES (?, ?, ?) ON CONFLICT(time) DO UPDATE SET price = excluded.price, total_assets = excluded.total_assets',
  ).run(hour, price, totalAssets.toString());
}
