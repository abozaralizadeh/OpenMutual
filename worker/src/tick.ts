import {
  advanceClaims,
  assessorDuty,
  chainNow,
  ladderOn,
  pretendJurorDuty,
  revealTests,
  revealVotes,
  ClaimReviewAbi,
  CoverBookAbi,
  demoResultFor,
  friendlyError,
  listClaims,
  listProposals,
  MemberGovernorAbi,
  mine,
  MutualPoolAbi,
  openCovers,
  productById,
  queryFromDetails,
  ResultOracleAbi,
  roleAccount,
  send,
  syncEvents,
  TimelockControllerAbi,
  trackSharePrice,
  voteOnClaim,
  voteOnProposal,
  hasVotedOnClaim,
  hasVotedOnProposal,
  type App,
  type DemoResults,
  type Logger,
  type ResultSource,
  flightRef,
  rainRef,
  accountAt,
} from '@openmutual/shared';
import type { Address, Hex, PrivateKeyAccount } from 'viem';

const REPORTERS = ['reporter0', 'reporter1', 'reporter2'] as const;
const QUEUE_BATCH = 20n;

/** A source's failure is logged and skipped, so it can't stop the others. */
async function reportResults(app: App, sources: ResultSource[], log: Logger, now: number) {
  const seen = new Set<string>();
  for (const cover of openCovers(app)) {
    if (seen.has(cover.event_key) || !cover.details) continue;
    seen.add(cover.event_key);
    if (productById(app.decisions, cover.product_id).kind !== 'automatic') continue;
    const query = queryFromDetails(JSON.parse(cover.details));
    if (!query) continue;

    const key = cover.event_key as Hex;
    for (const [index, source] of sources.entries()) {
      const reporter = roleAccount(REPORTERS[index]);
      const oracle = { address: app.addresses.oracle, abi: ResultOracleAbi } as const;
      const state = (await app.client.readContract({ ...oracle, functionName: 'state', args: [key] })) as number;
      if (state !== 1) break;
      const reported = (await app.client.readContract({ ...oracle, functionName: 'hasReported', args: [key, reporter.address] })) as boolean;
      if (reported) continue;

      try {
        const value = await source.read(query, now);
        if (value === null) continue;
        await send(app.client, reporter, { ...oracle, functionName: 'report', args: [key, value] });
        log.info(`${source.name} reported`, { subject: query.subject, date: query.date, value });
      } catch (error) {
        log.warn(`${source.name} failed for ${query.subject} ${query.date}`, error);
      }
    }
  }
}

async function endCovers(app: App, log: Logger) {
  const keeper = roleAccount('deployer');
  const book = { address: app.addresses.book, abi: CoverBookAbi } as const;
  const ready: bigint[] = [];
  for (const cover of openCovers(app)) {
    const id = BigInt(cover.id);
    if ((await app.client.readContract({ ...book, functionName: 'canSettle', args: [id] })) as boolean) ready.push(id);
    else if ((await app.client.readContract({ ...book, functionName: 'canRefund', args: [id] })) as boolean) {
      await send(app.client, keeper, { ...book, functionName: 'refund', args: [id] });
      log.info('Refunded a cover with no result', { id: cover.id });
    }
  }
  if (ready.length > 0) {
    await send(app.client, keeper, { ...book, functionName: 'settleMany', args: [ready] });
    log.info('Settled covers', { count: ready.length });
  }
}

async function processQueue(app: App) {
  const pool = { address: app.addresses.pool, abi: MutualPoolAbi } as const;
  const waiting = (await app.client.readContract({ ...pool, functionName: 'pendingWithdrawals' })) as bigint;
  if (waiting === 0n) return;
  await send(app.client, roleAccount('deployer'), { ...pool, functionName: 'processWithdrawals', args: [QUEUE_BATCH] });
}

async function finishVotes(app: App, log: Logger, now: number) {
  const keeper = roleAccount('deployer');
  for (const claim of await listClaims(app)) {
    if (claim.finished || claim.endsAt > now) continue;
    await send(app.client, keeper, { address: app.addresses.review, abi: ClaimReviewAbi, functionName: 'finish', args: [BigInt(claim.id)] });
    log.info('Finished a claim vote', { id: claim.id, yes: claim.yes, no: claim.no });
  }

  const governor = { address: app.addresses.governor, abi: MemberGovernorAbi } as const;
  for (const proposal of await listProposals(app)) {
    if (proposal.executed || proposal.endsAt > now) continue;
    if (!proposal.queued) {
      if (proposal.yes + proposal.no >= proposal.needed && proposal.yes > proposal.no) {
        await send(app.client, keeper, { ...governor, functionName: 'queue', args: [BigInt(proposal.id)] });
        log.info('Queued a passed proposal', { id: proposal.id });
      }
      continue;
    }
    const raw = (await app.client.readContract({ ...governor, functionName: 'proposals', args: [BigInt(proposal.id)] })) as unknown as unknown[];
    const target = raw[1] as Address;
    const data = raw[8] as Hex;
    const zero = `0x${'00'.repeat(32)}` as Hex;
    const salt = `0x${proposal.id.toString(16).padStart(64, '0')}` as Hex;
    const timelock = { address: app.addresses.timelock, abi: TimelockControllerAbi } as const;
    const id = (await app.client.readContract({ ...timelock, functionName: 'hashOperation', args: [target, 0n, data, zero, salt] })) as Hex;
    if ((await app.client.readContract({ ...timelock, functionName: 'isOperationReady', args: [id] })) as boolean) {
      await send(app.client, keeper, { ...governor, functionName: 'execute', args: [BigInt(proposal.id)] });
      log.info('Applied a passed proposal', { id: proposal.id });
    }
  }
}

const SIMULATED_MEMBER_START = 20;
const SIMULATED_MEMBER_COUNT = 5;

/** Pretend neighbours, so one person can try a vote alone. Clearly labelled in the app. */
export function simulatedMembers(): PrivateKeyAccount[] {
  return Array.from({ length: SIMULATED_MEMBER_COUNT }, (_, index) => accountAt(SIMULATED_MEMBER_START + index) as unknown as PrivateKeyAccount);
}

async function simulatedVotes(app: App, now: number) {
  for (const claim of await listClaims(app)) {
    if (claim.finished || claim.endsAt <= now) continue;
    const approve = !/fake/i.test(claim.evidence);
    for (const member of simulatedMembers()) {
      if (await hasVotedOnClaim(app, claim.id, member.address)) continue;
      if (member.address.toLowerCase() === claim.holder.toLowerCase()) continue;
      await voteOnClaim(app, member, claim.id, approve);
    }
  }
  for (const proposal of await listProposals(app)) {
    if (proposal.queued || proposal.endsAt <= now) continue;
    const support = !/reject/i.test(proposal.text);
    for (const member of simulatedMembers()) {
      if (await hasVotedOnProposal(app, proposal.id, member.address)) continue;
      await voteOnProposal(app, member, proposal.id, support);
    }
  }
}

export interface TickOptions {
  simulatedMembers?: boolean;
}

type Step = [string, () => Promise<void>];

/** Reveals first, then hidden tests, then moving claims on, then new answers. That order lets a test show itself before it pays. */
function ladderSteps(app: App, log: Logger, options: TickOptions): Step[] {
  if (!ladderOn(app)) return [];
  return [
    ['ladder reveals', () => revealVotes(app, log)],
    ['test reveals', () => revealTests(app, log)],
    ['ladder', () => advanceClaims(app, log)],
    ['assessors', () => assessorDuty(app, log)],
    ...(options.simulatedMembers ? ([['pretend jurors', () => pretendJurorDuty(app, log)]] as Step[]) : []),
  ];
}

/** One pass of everything that needs doing. Each step can fail alone and retry on the next pass. */
export async function tick(app: App, sources: ResultSource[], log: Logger, options: TickOptions = {}) {
  const steps: Step[] = [
    ['clock', () => mine(app.client)],
    ['sync', async () => void (await syncEvents(app.db, app.client, app.addresses))],
    ['report', async () => reportResults(app, sources, log, await chainNow(app.client))],
    ['end covers', () => endCovers(app, log)],
    ['queue', () => processQueue(app)],
    ['votes', async () => finishVotes(app, log, await chainNow(app.client))],
    ...(options.simulatedMembers ? ([['simulated votes', async () => simulatedVotes(app, await chainNow(app.client))]] as Step[]) : []),
    ['sync for the ladder', async () => void (await syncEvents(app.db, app.client, app.addresses))],
    ...ladderSteps(app, log, options),
    ['sync again', async () => void (await syncEvents(app.db, app.client, app.addresses))],
    ['share price', () => trackSharePrice(app)],
  ];
  for (const [name, step] of steps) {
    try {
      await step();
    } catch (error) {
      log.error(`Step failed: ${name}: ${friendlyError(error)}`, error);
    }
  }
}

/** Reads forced results from the admin page. The fake sources check this first. */
export function demoResults(app: App): DemoResults {
  return (query) => demoResultFor(app, query.kind === 'flight' ? flightRef(query.subject, query.date) : rainRef(query.subject, query.date));
}
