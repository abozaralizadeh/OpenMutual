import { randomBytes } from 'node:crypto';
import { encodeAbiParameters, keccak256, stringToHex, toBytes, toHex, type Account, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { bagOffer, coverById, isMember, makeQuote, productForCover, simDate, userAccount, type App, type User } from './app';
import { FAKE_ASSESSORS, fakeAssessor, humanVerdict, type Answer, type ClaimAssessor } from './assessors';
import { accountAt, chainNow, giveGas, roleAccount, send } from './chain';
import { ClaimLadderAbi, CoverBookAbi, MembershipAbi, TestUSDAbi } from './generated/abis';
import { syncEvents } from './indexer';
import type { Logger } from './logger';
import { chance } from './sources/fake-world';

// The claims ladder from the app's side: reading claims, answering in secret, revealing,
// moving claims on, and the fake judges that let one person try the whole thing alone.

export const STAGES = ['None', 'Panel', 'Challenge', 'Jury', 'AppealWindow', 'Appeal', 'Final', 'Done'] as const;
export const OUTCOMES = ['None', 'Pay', 'Deny', 'NoDecision'] as const;
export type Stage = (typeof STAGES)[number];
export type Outcome = (typeof OUTCOMES)[number];

const VERDICT_NUMBER: Record<Answer, number> = { pay: 1, deny: 2, unclear: 3 };
const ANSWERS: (Answer | null)[] = [null, 'pay', 'deny', 'unclear'];

export function answerOf(verdict: number): Answer | null {
  return ANSWERS[verdict] ?? null;
}

/** True when claims go to the ladder. Older local deployments have no ladder, so they keep the member vote. */
export function ladderOn(app: App): boolean {
  return app.decisions.claims.mode !== 'vote' && Boolean(app.addresses.ladder);
}

function ladder(app: App) {
  return { address: app.addresses.ladder, abi: ClaimLadderAbi } as const;
}

// Who sits on claims in the simulation

const JUROR_START = 30;
const ASSESSOR_START = 50;
export const PRETEND_JUROR_COUNT = 20;

export interface AssessorSeat {
  assessor: ClaimAssessor;
  account: Account;
}

/** Each fake assessor has its own local test wallet, which holds its bond. */
export function assessorSeats(): AssessorSeat[] {
  return FAKE_ASSESSORS.map((settings, index) => ({ assessor: fakeAssessor(settings), account: accountAt(ASSESSOR_START + index) }));
}

/** Pretend members who sit on juries, so one person can see a jury decide. Clearly labelled in the app. */
export function pretendJurors(): Account[] {
  return Array.from({ length: PRETEND_JUROR_COUNT }, (_, index) => accountAt(JUROR_START + index));
}

/** A name to show for a judge. Real members stay anonymous. */
export function judgeName(address: Address): string {
  const lower = address.toLowerCase();
  const seat = assessorSeats().find((item) => item.account.address.toLowerCase() === lower);
  if (seat) return seat.assessor.name;
  const juror = pretendJurors().findIndex((item) => item.address.toLowerCase() === lower);
  if (juror >= 0) return `Pretend juror ${juror + 1}`;
  return 'A member';
}

/** The local test wallet behind an address, so the app can reveal answers for the people it holds keys for. */
function accountFor(app: App, wallet: Address): Account | null {
  const lower = wallet.toLowerCase();
  const user = app.db.prepare('SELECT wallet_key FROM users WHERE lower(wallet) = ?').get(lower) as { wallet_key: Hex } | undefined;
  if (user) return privateKeyToAccount(user.wallet_key);
  const test = app.db.prepare('SELECT wallet_key FROM test_claims WHERE lower(wallet) = ?').get(lower) as { wallet_key: Hex } | undefined;
  if (test) return privateKeyToAccount(test.wallet_key);
  const known = [...assessorSeats().map((item) => item.account), ...pretendJurors()];
  return known.find((item) => item.address.toLowerCase() === lower) ?? null;
}

async function approveLadder(app: App, account: Account) {
  const allowance = (await app.client.readContract({
    address: app.addresses.usd,
    abi: TestUSDAbi,
    functionName: 'allowance',
    args: [account.address, app.addresses.ladder],
  })) as bigint;
  if (allowance >= 2n ** 128n) return;
  await send(app.client, account, { address: app.addresses.usd, abi: TestUSDAbi, functionName: 'approve', args: [app.addresses.ladder, 2n ** 256n - 1n] });
}

/** Puts the fake assessors and, if asked, the pretend jurors in their seats. Safe to run again. */
export async function seedLadder(app: App, options: { pretendJurors?: boolean } = {}) {
  if (!ladderOn(app)) return;
  await giveGas(app.client, roleAccount('auditor').address);
  const join = async (account: Account, assessorMaker: string | null) => {
    await giveGas(app.client, account.address);
    const seat = (await app.client.readContract({ ...ladder(app), functionName: 'getSeat', args: [account.address, assessorMaker !== null] })) as { active: boolean };
    if (seat.active) return;
    await send(app.client, account, { address: app.addresses.usd, abi: TestUSDAbi, functionName: 'faucet', args: [account.address] });
    await approveLadder(app, account);
    if (assessorMaker !== null) {
      await send(app.client, account, { ...ladder(app), functionName: 'joinAssessors', args: [stringToHex(assessorMaker, { size: 32 })] });
    } else {
      await send(app.client, account, { ...ladder(app), functionName: 'joinJury' });
    }
  };
  for (const { assessor, account } of assessorSeats()) await join(account, assessor.maker);
  if (!options.pretendJurors) return;
  for (const juror of pretendJurors()) {
    await giveGas(app.client, juror.address);
    if (!(await isMember(app, juror.address))) {
      await send(app.client, roleAccount('verifier'), { address: app.addresses.members, abi: MembershipAbi, functionName: 'add', args: [juror.address] });
    }
    await join(juror, null);
  }
}

// Reading

interface ChainClaim {
  coverId: bigint;
  holder: Address;
  evidenceHash: Hex;
  openedAt: number;
  stage: number;
  round: number;
  panelVerdict: number;
  juryVerdict: number;
  windowEnds: number;
  readyAt: number;
  challenger: Address;
  appellant: Address;
  appealHeard: boolean;
  outcome: number;
  test: boolean;
}

interface ChainRound {
  seats: readonly Address[];
  commitEnds: number;
  revealEnds: number;
  committed: number;
  revealed: number;
  pay: number;
  deny: number;
  unclear: number;
  lowestConfidence: number;
}

export interface LadderAnswer {
  who: Address;
  name: string;
  verdict: Answer;
  confidence: number;
  reason: string | null;
}

export interface LadderRound {
  round: number;
  seats: Address[];
  commitEnds: number;
  revealEnds: number;
  committed: number;
  revealed: number;
  pay: number;
  deny: number;
  unclear: number;
  answers: LadderAnswer[];
}

export interface LadderClaim {
  id: number;
  coverId: number;
  holder: Address;
  evidence: string;
  openedAt: number;
  stage: Stage;
  round: number;
  panelVerdict: Answer | null;
  juryVerdict: Answer | null;
  windowEnds: number;
  readyAt: number;
  challenger: Address | null;
  appellant: Address | null;
  appealHeard: boolean;
  outcome: Outcome;
  test: boolean;
  label: string | null;
  rounds: LadderRound[];
}

const NOBODY = '0x0000000000000000000000000000000000000000';

async function chainClaim(app: App, claimId: number): Promise<ChainClaim> {
  return (await app.client.readContract({ ...ladder(app), functionName: 'getClaim', args: [BigInt(claimId)] })) as unknown as ChainClaim;
}

async function chainRound(app: App, claimId: number, round: number): Promise<ChainRound> {
  return (await app.client.readContract({ ...ladder(app), functionName: 'getRound', args: [BigInt(claimId), round] })) as unknown as ChainRound;
}

function answersFor(app: App, claimId: number, round: number): LadderAnswer[] {
  const rows = app.db
    .prepare("SELECT args FROM chain_events WHERE contract = 'ladder' AND name = 'Revealed' AND json_extract(args, '$.claimId') = ? ORDER BY block, log_index")
    .all(String(claimId)) as { args: string }[];
  return rows
    .map((row) => JSON.parse(row.args) as { round: number; who: Address; verdict: number; confidence: number; reasonHash: Hex })
    .filter((item) => Number(item.round) === round)
    .map((item) => {
      const note = app.db.prepare('SELECT text FROM claim_notes WHERE hash = ?').get(item.reasonHash) as { text: string } | undefined;
      return { who: item.who, name: judgeName(item.who), verdict: answerOf(Number(item.verdict))!, confidence: Number(item.confidence), reason: note?.text ?? null };
    });
}

export async function readLadderClaim(app: App, claimId: number): Promise<LadderClaim> {
  const claim = await chainClaim(app, claimId);
  const rounds: LadderRound[] = [];
  for (const round of [0, 1, 2]) {
    const r = await chainRound(app, claimId, round);
    if (r.seats.length === 0) continue;
    rounds.push({
      round,
      seats: [...r.seats],
      commitEnds: Number(r.commitEnds),
      revealEnds: Number(r.revealEnds),
      committed: r.committed,
      revealed: r.revealed,
      pay: r.pay,
      deny: r.deny,
      unclear: r.unclear,
      answers: answersFor(app, claimId, round),
    });
  }
  const evidence = app.db.prepare('SELECT text FROM claim_evidence WHERE evidence_hash = ?').get(claim.evidenceHash) as { text: string } | undefined;
  const coverId = Number(claim.coverId);
  return {
    id: claimId,
    coverId,
    holder: claim.holder,
    evidence: evidence?.text ?? '(text not found)',
    openedAt: Number(claim.openedAt),
    stage: STAGES[claim.stage],
    round: claim.round,
    panelVerdict: answerOf(claim.panelVerdict),
    juryVerdict: answerOf(claim.juryVerdict),
    windowEnds: Number(claim.windowEnds),
    readyAt: Number(claim.readyAt),
    challenger: claim.challenger === NOBODY ? null : claim.challenger,
    appellant: claim.appellant === NOBODY ? null : claim.appellant,
    appealHeard: claim.appealHeard,
    outcome: OUTCOMES[claim.outcome],
    test: claim.test,
    label: coverById(app, coverId)?.label ?? null,
    rounds,
  };
}

/** Claims that haven't finished, from the synced events. */
export function openLadderClaimIds(app: App): number[] {
  const rows = app.db
    .prepare(
      `SELECT json_extract(args, '$.claimId') AS id FROM chain_events WHERE contract = 'ladder' AND name = 'ClaimOpened'
       AND json_extract(args, '$.claimId') NOT IN (
         SELECT json_extract(args, '$.claimId') FROM chain_events WHERE contract = 'ladder' AND name IN ('ClaimDone', 'TestRevealed')
       ) ORDER BY block`,
    )
    .all() as { id: string }[];
  return rows.map((row) => Number(row.id));
}

export async function ladderClaimCount(app: App): Promise<number> {
  return Number(await app.client.readContract({ ...ladder(app), functionName: 'claimCount' }));
}

/** Every claim, newest first. Fine for a local simulation, a real one would page. */
export async function listLadderClaims(app: App, limit = 50): Promise<LadderClaim[]> {
  const count = await ladderClaimCount(app);
  const claims: LadderClaim[] = [];
  for (let id = count; id >= 1 && claims.length < limit; id--) claims.push(await readLadderClaim(app, id));
  return claims;
}

export async function ladderClaimForCover(app: App, coverId: number): Promise<LadderClaim | null> {
  const row = app.db
    .prepare("SELECT json_extract(args, '$.claimId') AS id FROM chain_events WHERE contract = 'ladder' AND name = 'ClaimOpened' AND json_extract(args, '$.coverId') = ? ORDER BY block DESC")
    .get(String(coverId)) as { id: string } | undefined;
  return row ? readLadderClaim(app, Number(row.id)) : null;
}

export interface JudgeRow {
  address: Address;
  name: string;
  maker: string | null;
  active: boolean;
  eligible: boolean;
  bond: bigint;
  reputation: number;
  testsPassed: number;
  testsFailed: number;
}

async function judgeRow(app: App, address: Address, isAssessor: boolean, maker: string | null): Promise<JudgeRow> {
  const [seat, eligible] = await Promise.all([
    app.client.readContract({ ...ladder(app), functionName: 'getSeat', args: [address, isAssessor] }) as Promise<{
      active: boolean;
      bond: bigint;
      reputation: number;
      testsPassed: number;
      testsFailed: number;
    }>,
    app.client.readContract({ ...ladder(app), functionName: 'eligible', args: [address, isAssessor] }) as Promise<boolean>,
  ]);
  return {
    address,
    name: judgeName(address),
    maker,
    active: seat.active,
    eligible,
    bond: seat.bond,
    reputation: seat.reputation,
    testsPassed: seat.testsPassed,
    testsFailed: seat.testsFailed,
  };
}

export async function assessorTable(app: App): Promise<JudgeRow[]> {
  return Promise.all(assessorSeats().map(({ assessor, account }) => judgeRow(app, account.address, true, assessor.maker)));
}

export async function jurySeat(app: App, wallet: Address): Promise<JudgeRow> {
  return judgeRow(app, wallet, false, null);
}

export async function juryCount(app: App): Promise<number> {
  const count = Number(await app.client.readContract({ ...ladder(app), functionName: 'jurorCount' }));
  let active = 0;
  for (let index = 0; index < count; index++) {
    const who = (await app.client.readContract({ ...ladder(app), functionName: 'jurorAt', args: [BigInt(index)] })) as Address;
    if ((await app.client.readContract({ ...ladder(app), functionName: 'eligible', args: [who, false] })) as boolean) active++;
  }
  return active;
}

export async function ladderSettingsNow(app: App) {
  return (await app.client.readContract({ ...ladder(app), functionName: 'getSettings' })) as {
    jurorBond: bigint;
    challengeBond: bigint;
    appealBond: bigint;
    minConfidence: number;
  };
}

// Answering in secret, then revealing

export function voteHash(claimId: number, round: number, who: Address, verdict: number, confidence: number, reasonHash: Hex, salt: Hex): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: 'uint256' }, { type: 'uint8' }, { type: 'address' }, { type: 'uint8' }, { type: 'uint8' }, { type: 'bytes32' }, { type: 'bytes32' }],
      [BigInt(claimId), round, who, verdict, confidence, reasonHash, salt],
    ),
  );
}

export function testHash(coverId: number, expected: number, salt: Hex): Hex {
  return keccak256(encodeAbiParameters([{ type: 'uint256' }, { type: 'uint8' }, { type: 'bytes32' }], [BigInt(coverId), expected, salt]));
}

/** Seals an answer on chain. The answer and its salt wait in the database until the reveal opens. */
export async function castVote(app: App, account: Account, claimId: number, answer: Answer, confidence: number, reason: string) {
  const { round } = await chainClaim(app, claimId);
  const salt = toHex(randomBytes(32));
  const reasonHash = keccak256(toBytes(reason));
  const verdict = VERDICT_NUMBER[answer];
  app.db.prepare('INSERT OR IGNORE INTO claim_notes (hash, text) VALUES (?, ?)').run(reasonHash, reason);
  app.db
    .prepare('INSERT INTO ladder_votes (claim_id, round, wallet, verdict, confidence, reason_hash, salt) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(claimId, round, account.address.toLowerCase(), verdict, confidence, reasonHash, salt);
  try {
    await send(app.client, account, {
      ...ladder(app),
      functionName: 'commit',
      args: [BigInt(claimId), voteHash(claimId, round, account.address, verdict, confidence, reasonHash, salt)],
    });
  } catch (error) {
    app.db.prepare('DELETE FROM ladder_votes WHERE claim_id = ? AND round = ? AND wallet = ?').run(claimId, round, account.address.toLowerCase());
    throw error;
  }
}

export interface MyVote {
  verdict: Answer;
  state: string;
}

export function myVote(app: App, claimId: number, round: number, wallet: Address): MyVote | null {
  const row = app.db
    .prepare('SELECT verdict, state FROM ladder_votes WHERE claim_id = ? AND round = ? AND wallet = ?')
    .get(claimId, round, wallet.toLowerCase()) as { verdict: number; state: string } | undefined;
  return row ? { verdict: answerOf(row.verdict)!, state: row.state } : null;
}

const IN_ROUND: Stage[] = ['Panel', 'Jury', 'Appeal'];

/** Reveals every sealed answer whose reveal has opened. Answers on a claim that moved on are marked missed. */
export async function revealVotes(app: App, log: Logger) {
  const rows = app.db.prepare("SELECT * FROM ladder_votes WHERE state = 'sealed' ORDER BY claim_id").all() as {
    claim_id: number;
    round: number;
    wallet: Address;
    verdict: number;
    confidence: number;
    reason_hash: Hex;
    salt: Hex;
  }[];
  if (rows.length === 0) return;
  const now = await chainNow(app.client);
  const mark = app.db.prepare('UPDATE ladder_votes SET state = ? WHERE claim_id = ? AND round = ? AND wallet = ?');
  for (const row of rows) {
    const claim = await chainClaim(app, row.claim_id);
    if (!IN_ROUND.includes(STAGES[claim.stage]) || claim.round !== row.round) {
      mark.run('missed', row.claim_id, row.round, row.wallet);
      continue;
    }
    const round = await chainRound(app, row.claim_id, row.round);
    if (now < round.commitEnds && round.committed < round.seats.length) continue;
    const account = accountFor(app, row.wallet);
    if (!account) continue;
    try {
      await send(app.client, account, {
        ...ladder(app),
        functionName: 'reveal',
        args: [BigInt(row.claim_id), row.verdict, row.confidence, row.reason_hash, row.salt],
      });
      mark.run('revealed', row.claim_id, row.round, row.wallet);
    } catch (error) {
      log.warn('A reveal failed', { claim: row.claim_id, round: row.round, error: String(error).slice(0, 200) });
    }
  }
}

/** Moves every claim on as far as the rules allow. Stops at the final answer, so a hidden test can show itself first. */
export async function advanceClaims(app: App, log: Logger) {
  const keeper = roleAccount('deployer');
  for (const id of openLadderClaimIds(app)) {
    for (let step = 0; step < 4; step++) {
      if (!((await app.client.readContract({ ...ladder(app), functionName: 'canAdvance', args: [BigInt(id)] })) as boolean)) break;
      const before = STAGES[(await chainClaim(app, id)).stage];
      if (before === 'Final' && step > 0) break;
      await send(app.client, keeper, { ...ladder(app), functionName: 'advance', args: [BigInt(id)] });
      const after = await chainClaim(app, id);
      log.info('Moved a claim on', { id, from: before, to: STAGES[after.stage], outcome: OUTCOMES[after.outcome] });
    }
  }
}

async function seatedAndSilent(app: App, claimId: number, round: number, who: Address) {
  const seated = (await app.client.readContract({ ...ladder(app), functionName: 'onSeat', args: [BigInt(claimId), round, who] })) as boolean;
  if (!seated) return false;
  const sealed = (await app.client.readContract({ ...ladder(app), functionName: 'commits', args: [BigInt(claimId), round, who] })) as Hex;
  return BigInt(sealed) === 0n;
}

/** The fake AI panel answers every claim it's seated on. */
export async function assessorDuty(app: App, log: Logger) {
  const now = await chainNow(app.client);
  for (const id of openLadderClaimIds(app)) {
    const claim = await chainClaim(app, id);
    if (STAGES[claim.stage] !== 'Panel') continue;
    if (now >= (await chainRound(app, id, 0)).commitEnds) continue;
    const cover = coverById(app, Number(claim.coverId));
    const wording = cover ? productForCover(app, cover).wording ?? '' : '';
    const evidence = (app.db.prepare('SELECT text FROM claim_evidence WHERE evidence_hash = ?').get(claim.evidenceHash) as { text: string } | undefined)?.text ?? '';
    for (const { assessor, account } of assessorSeats()) {
      if (!(await seatedAndSilent(app, id, 0, account.address))) continue;
      const answer = await assessor.assess({ claimId: id, wording, evidence });
      await castVote(app, account, id, answer.verdict, answer.confidence, answer.reason);
      log.info('An assessor answered', { id, assessor: assessor.name });
    }
  }
}

export interface PretendJurorOptions {
  /** How often a pretend juror gets a claim wrong. */
  errorRate?: number;
  /** How often one doesn't answer at all. */
  noShowRate?: number;
}

/** Pretend jurors answer the juries they're picked for, so a jury can decide with one real person or none. */
export async function pretendJurorDuty(app: App, log: Logger, options: PretendJurorOptions = {}) {
  const { errorRate = 0.05, noShowRate = 0 } = options;
  const now = await chainNow(app.client);
  for (const id of openLadderClaimIds(app)) {
    const claim = await chainClaim(app, id);
    const stage = STAGES[claim.stage];
    if (stage !== 'Jury' && stage !== 'Appeal') continue;
    if (now >= (await chainRound(app, id, claim.round)).commitEnds) continue;
    const evidence = (app.db.prepare('SELECT text FROM claim_evidence WHERE evidence_hash = ?').get(claim.evidenceHash) as { text: string } | undefined)?.text ?? '';
    for (const juror of pretendJurors()) {
      if (!(await seatedAndSilent(app, id, claim.round, juror.address))) continue;
      const name = judgeName(juror.address);
      if (chance(`no-show:${name}:${id}:${claim.round}`) < noShowRate) continue;
      const answer = humanVerdict(name, { claimId: id, evidence }, errorRate);
      await castVote(app, juror, id, answer.verdict, answer.confidence, answer.reason);
    }
    log.info('Pretend jurors answered', { id, round: claim.round });
  }
}

// What members and claimants can do

export async function joinJury(app: App, user: User) {
  const account = userAccount(user);
  await approveLadder(app, account);
  await send(app.client, account, { ...ladder(app), functionName: 'joinJury' });
}

export async function leaveJury(app: App, user: User) {
  await send(app.client, userAccount(user), { ...ladder(app), functionName: 'leaveJury' });
}

export async function challengeClaim(app: App, user: User, claimId: number) {
  const account = userAccount(user);
  await approveLadder(app, account);
  await send(app.client, account, { ...ladder(app), functionName: 'challenge', args: [BigInt(claimId)] });
  await syncEvents(app.db, app.client, app.addresses);
}

export async function appealClaim(app: App, user: User, claimId: number) {
  const account = userAccount(user);
  await approveLadder(app, account);
  await send(app.client, account, { ...ladder(app), functionName: 'appeal', args: [BigInt(claimId)] });
  await syncEvents(app.db, app.client, app.addresses);
}

export async function challengeAs(app: App, account: Account, claimId: number) {
  await approveLadder(app, account);
  await send(app.client, account, { ...ladder(app), functionName: 'challenge', args: [BigInt(claimId)] });
}

export async function appealAs(app: App, account: Account, claimId: number) {
  await approveLadder(app, account);
  await send(app.client, account, { ...ladder(app), functionName: 'appeal', args: [BigInt(claimId)] });
}

// Hidden test claims

/**
 * Files a claim whose right answer the auditor locked in first, from a fresh wallet nobody knows.
 * After the final answer the test wallet shows it was a test, judges are scored against the locked
 * answer and the price goes back. To the judges it looks like any other claim.
 */
export async function sendTestClaim(app: App, evidence: string, expected: 'pay' | 'deny'): Promise<{ coverId: number; claimId: number }> {
  const key = generatePrivateKey();
  const account = privateKeyToAccount(key);
  await giveGas(app.client, account.address);
  await giveGas(app.client, roleAccount('auditor').address);
  await send(app.client, account, { address: app.addresses.usd, abi: TestUSDAbi, functionName: 'faucet', args: [account.address] });
  await send(app.client, account, { address: app.addresses.usd, abi: TestUSDAbi, functionName: 'approve', args: [app.addresses.book, 2n ** 256n - 1n] });

  const signed = await makeQuote(app, bagOffer(app, account.address, await simDate(app)), account.address);
  const quote = { ...signed.quote, premium: BigInt(signed.quote.premium), payout: BigInt(signed.quote.payout) };
  const { result } = await send(app.client, account, { address: app.addresses.book, abi: CoverBookAbi, functionName: 'buy', args: [quote, signed.signature] });
  const coverId = Number(result);

  const salt = toHex(randomBytes(32));
  const verdict = VERDICT_NUMBER[expected];
  await send(app.client, roleAccount('auditor'), { ...ladder(app), functionName: 'commitTest', args: [testHash(coverId, verdict, salt)] });
  app.db
    .prepare('INSERT INTO test_claims (cover_id, wallet, wallet_key, expected, salt) VALUES (?, ?, ?, ?, ?)')
    .run(coverId, account.address.toLowerCase(), key, verdict, salt);

  const evidenceHash = keccak256(toBytes(evidence));
  app.db.prepare('INSERT OR IGNORE INTO claim_evidence (evidence_hash, text) VALUES (?, ?)').run(evidenceHash, evidence);
  await send(app.client, account, { address: app.addresses.book, abi: CoverBookAbi, functionName: 'fileClaim', args: [BigInt(coverId), evidenceHash] });
  await syncEvents(app.db, app.client, app.addresses);
  const claim = await ladderClaimForCover(app, coverId);
  app.db.prepare('UPDATE test_claims SET claim_id = ? WHERE cover_id = ?').run(claim?.id ?? null, coverId);
  return { coverId, claimId: claim?.id ?? 0 };
}

/** Shows test claims for what they are once their answer is final, before they would pay. */
export async function revealTests(app: App, log: Logger) {
  const rows = app.db.prepare("SELECT * FROM test_claims WHERE state = 'filed' AND claim_id IS NOT NULL").all() as {
    cover_id: number;
    claim_id: number;
    wallet_key: Hex;
    expected: number;
    salt: Hex;
  }[];
  const mark = app.db.prepare('UPDATE test_claims SET state = ? WHERE cover_id = ?');
  for (const row of rows) {
    const stage = STAGES[(await chainClaim(app, row.claim_id)).stage];
    if (stage === 'Done') {
      mark.run('missed', row.cover_id);
      continue;
    }
    if (stage !== 'Final') continue;
    await send(app.client, privateKeyToAccount(row.wallet_key), {
      ...ladder(app),
      functionName: 'revealTest',
      args: [BigInt(row.claim_id), row.expected, row.salt],
    });
    mark.run('revealed', row.cover_id);
    log.info('A hidden test claim showed itself', { claim: row.claim_id, expected: answerOf(row.expected) });
  }
}

export interface TestClaimRow {
  coverId: number;
  claimId: number | null;
  expected: Answer;
  state: string;
}

export function testClaims(app: App): TestClaimRow[] {
  const rows = app.db.prepare('SELECT cover_id, claim_id, expected, state FROM test_claims ORDER BY cover_id DESC').all() as {
    cover_id: number;
    claim_id: number | null;
    expected: number;
    state: string;
  }[];
  return rows.map((row) => ({ coverId: row.cover_id, claimId: row.claim_id, expected: answerOf(row.expected)!, state: row.state }));
}
