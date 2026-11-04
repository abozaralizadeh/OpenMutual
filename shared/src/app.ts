import { createHash, randomBytes } from 'node:crypto';
import { encodeFunctionData, formatUnits, keccak256, parseUnits, toBytes, type Abi, type Account, type Address, type Hex, type PublicClient } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { chainNow, giveGas, publicClient, roleAccount, send } from './chain';
import { loadDecisions, productById, productId, type Decisions, type ProductConfig } from './config';
import { countUse, openDb, type Db } from './db';
import { DAY, loadDeployment, type Addresses } from './deploy';
import {
  ClaimReviewAbi,
  CoverBookAbi,
  MemberGovernorAbi,
  MembershipAbi,
  MutualPoolAbi,
  ResultOracleAbi,
  TeamMultisigAbi,
  TestUSDAbi,
  TimelockControllerAbi,
} from './generated/abis';
import { fakeIdentityProvider, type IdentityProvider } from './identity';
import { recordSharePrice, syncEvents } from './indexer';
import { pricingEngine, type PricingEngine } from './pricing';
import { flightRef, rainRef, refFor } from './refs';
import { dateOf, dayStart, findFlight, flightsOn, citiesList } from './sources/fake-world';

export interface App {
  db: Db;
  client: PublicClient;
  addresses: Addresses;
  decisions: Decisions;
  pricing: PricingEngine;
  identity: IdentityProvider;
}

export function createApp(overrides: Partial<App> = {}): App {
  const decisions = overrides.decisions ?? loadDecisions();
  return {
    db: overrides.db ?? openDb(),
    client: overrides.client ?? (publicClient() as PublicClient),
    addresses: overrides.addresses ?? loadDeployment(),
    decisions,
    pricing: overrides.pricing ?? pricingEngine(decisions),
    identity: overrides.identity ?? fakeIdentityProvider(),
  };
}

const QUOTE_LIFETIME = 600;
const HOUR = 3600;

const quoteTypes = {
  Quote: [
    { name: 'productId', type: 'uint32' },
    { name: 'ref', type: 'bytes32' },
    { name: 'eventTime', type: 'uint40' },
    { name: 'premium', type: 'uint128' },
    { name: 'payout', type: 'uint128' },
    { name: 'buyer', type: 'address' },
    { name: 'expiresAt', type: 'uint40' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const;

export function emailHash(email: string): string {
  return createHash('sha256').update(email.trim().toLowerCase()).digest('hex');
}

export function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

export function toUsd(units: bigint | string | number): number {
  return Number(formatUnits(BigInt(units), 6));
}

export function fromUsd(usd: number | string): bigint {
  return parseUnits(String(usd), 6);
}

// Users and their local test wallets

export interface User {
  id: number;
  wallet: Address;
  wallet_key: Hex;
}

/** Each person gets a wallet made for them. It only ever holds test money on the local chain. */
export async function createUser(app: App, email: string): Promise<User> {
  const hash = emailHash(email);
  const existing = app.db.prepare('SELECT id, wallet, wallet_key FROM users WHERE email_hash = ?').get(hash) as User | undefined;
  if (existing) return existing;

  const key = generatePrivateKey();
  const account = privateKeyToAccount(key);
  await giveGas(app.client, account.address);
  await send(app.client, account, { address: app.addresses.usd, abi: TestUSDAbi, functionName: 'faucet', args: [account.address] });
  await approveAll(app, account);
  const result = app.db
    .prepare('INSERT INTO users (email_hash, wallet, wallet_key, created_at) VALUES (?, ?, ?, ?)')
    .run(hash, account.address, key, Math.floor(Date.now() / 1000));
  countUse(app.db, 'signup');
  return { id: Number(result.lastInsertRowid), wallet: account.address, wallet_key: key };
}

async function approveAll(app: App, account: Account) {
  const max = 2n ** 256n - 1n;
  await send(app.client, account, { address: app.addresses.usd, abi: TestUSDAbi, functionName: 'approve', args: [app.addresses.pool, max] });
  await send(app.client, account, { address: app.addresses.usd, abi: TestUSDAbi, functionName: 'approve', args: [app.addresses.book, max] });
  // The ladder holds jury bonds, and bonds to challenge or appeal.
  if (app.addresses.ladder) {
    await send(app.client, account, { address: app.addresses.usd, abi: TestUSDAbi, functionName: 'approve', args: [app.addresses.ladder, max] });
  }
}

export function userAccount(user: User) {
  return privateKeyToAccount(user.wallet_key);
}

export async function getMoreTestMoney(app: App, user: User) {
  await send(app.client, userAccount(user), { address: app.addresses.usd, abi: TestUSDAbi, functionName: 'faucet', args: [user.wallet] });
  countUse(app.db, 'faucet');
}

// Quotes and buying

export interface Offer {
  productKey: string;
  ref: Hex;
  eventTime: number;
  payout: bigint;
  label: string;
  details: Record<string, string>;
  route?: { from: string; to: string; date: string };
}

export function flightOffer(app: App, number: string, date: string): Offer {
  const flight = findFlight(number, date);
  if (!flight) throw new Error('No test flight with that number on that day.');
  const product = app.decisions.products.find((item) => item.key === 'flight-delay')!;
  return {
    productKey: product.key,
    ref: flightRef(number, date),
    eventTime: flight.departure,
    payout: fromUsd(product.payoutUsd),
    label: `${flight.number} ${flight.from} to ${flight.to} on ${date}`,
    details: { kind: 'flight', subject: number, date },
    route: { from: flight.from, to: flight.to, date },
  };
}

export function rainOffer(app: App, city: string, date: string): Offer {
  if (!citiesList().includes(city)) throw new Error('No test weather for that city.');
  const product = app.decisions.products.find((item) => item.key === 'rainy-day')!;
  return {
    productKey: product.key,
    ref: rainRef(city, date),
    eventTime: dayStart(date),
    payout: fromUsd(product.payoutUsd),
    label: `Rain in ${city} on ${date}`,
    details: { kind: 'rain', subject: city, date },
  };
}

export function bagOffer(app: App, buyer: Address, date: string): Offer {
  const product = app.decisions.products.find((item) => item.key === 'lost-bag')!;
  // Each bag cover is its own event, so the ref is unique to this purchase.
  const unique = randomBytes(8).toString('hex');
  return {
    productKey: product.key,
    ref: refFor(`bag:${buyer}:${date}:${unique}`),
    eventTime: dayStart(date) + DAY - 1,
    payout: fromUsd(product.payoutUsd),
    label: `Bag on a trip ending ${date}`,
    details: { kind: 'bag', subject: buyer, date },
  };
}

export interface SignedQuote {
  quote: {
    productId: number;
    ref: Hex;
    eventTime: number;
    premium: string;
    payout: string;
    buyer: Address;
    expiresAt: number;
    nonce: Hex;
  };
  signature: Hex;
  label: string;
  chance: number;
}

export async function makeQuote(app: App, offer: Offer, buyer: Address): Promise<SignedQuote> {
  const price = app.pricing.price({ productKey: offer.productKey, payout: offer.payout, route: offer.route });
  const now = await chainNow(app.client);
  const id = productId(app.decisions, offer.productKey);
  const quote = {
    productId: id,
    ref: offer.ref,
    eventTime: offer.eventTime,
    premium: price.premium,
    payout: offer.payout,
    buyer,
    expiresAt: now + QUOTE_LIFETIME,
    nonce: `0x${randomBytes(32).toString('hex')}` as Hex,
  };
  const signature = await roleAccount('quoter').signTypedData({
    domain: { name: 'OpenMutual', version: '1', chainId: 31337, verifyingContract: app.addresses.book },
    types: quoteTypes,
    primaryType: 'Quote',
    message: quote,
  });
  app.db
    .prepare('INSERT OR IGNORE INTO labels (ref, kind, label, details) VALUES (?, ?, ?, ?)')
    .run(offer.ref, offer.details.kind, offer.label, JSON.stringify(offer.details));
  return {
    quote: { ...quote, premium: quote.premium.toString(), payout: quote.payout.toString() },
    signature,
    label: offer.label,
    chance: price.chance,
  };
}

export async function buyCover(app: App, user: User, signed: SignedQuote): Promise<number> {
  if (signed.quote.buyer.toLowerCase() !== user.wallet.toLowerCase()) throw new Error('This price is for someone else.');
  const quote = { ...signed.quote, premium: BigInt(signed.quote.premium), payout: BigInt(signed.quote.payout) };
  const { result } = await send(app.client, userAccount(user), {
    address: app.addresses.book,
    abi: CoverBookAbi,
    functionName: 'buy',
    args: [quote, signed.signature],
  });
  countUse(app.db, 'cover_bought');
  await syncEvents(app.db, app.client, app.addresses);
  return Number(result);
}

// Backing the pool

export async function depositToPool(app: App, user: User, amount: bigint) {
  await send(app.client, userAccount(user), { address: app.addresses.pool, abi: MutualPoolAbi, functionName: 'deposit', args: [amount, user.wallet] });
  countUse(app.db, 'deposit');
}

export async function askToWithdraw(app: App, user: User, shares: bigint) {
  await send(app.client, userAccount(user), { address: app.addresses.pool, abi: MutualPoolAbi, functionName: 'requestWithdrawal', args: [shares] });
  countUse(app.db, 'withdrawal_request');
}

// Reading

export interface PoolNumbers {
  totalAssets: bigint;
  lockedCapital: bigint;
  freeCapital: bigint;
  unearnedPremiums: bigint;
  balance: bigint;
  totalShares: bigint;
  sharePrice: number;
  poolCap: bigint;
  withdrawalWait: number;
  memberRebateBps: number;
  paused: boolean;
  pendingWithdrawals: number;
}

export async function poolNumbers(app: App): Promise<PoolNumbers> {
  const pool = { address: app.addresses.pool, abi: MutualPoolAbi } as const;
  const read = (functionName: string, args: unknown[] = []) => app.client.readContract({ ...pool, functionName, args } as never) as Promise<bigint>;
  const [totalAssets, lockedCapital, freeCapital, unearnedPremiums, totalShares, poolCap, withdrawalWait, memberRebateBps, paused, pendingWithdrawals, decimals, balance] =
    await Promise.all([
      read('totalAssets'),
      read('lockedCapital'),
      read('freeCapital'),
      read('unearnedPremiums'),
      read('totalSupply'),
      read('poolCap'),
      read('withdrawalWait'),
      read('memberRebateBps'),
      read('paused') as unknown as Promise<boolean>,
      read('pendingWithdrawals'),
      read('decimals') as unknown as Promise<number>,
      app.client.readContract({ address: app.addresses.usd, abi: TestUSDAbi, functionName: 'balanceOf', args: [app.addresses.pool] }) as Promise<bigint>,
    ]);
  const oneShare = 10n ** BigInt(decimals);
  const priceUnits = await read('convertToAssets', [oneShare]);
  return {
    totalAssets,
    lockedCapital,
    freeCapital,
    unearnedPremiums,
    balance,
    totalShares,
    sharePrice: toUsd(priceUnits),
    poolCap,
    withdrawalWait: Number(withdrawalWait),
    memberRebateBps: Number(memberRebateBps),
    paused,
    pendingWithdrawals: Number(pendingWithdrawals),
  };
}

export async function walletNumbers(app: App, wallet: Address) {
  const [money, shares] = await Promise.all([
    app.client.readContract({ address: app.addresses.usd, abi: TestUSDAbi, functionName: 'balanceOf', args: [wallet] }) as Promise<bigint>,
    app.client.readContract({ address: app.addresses.pool, abi: MutualPoolAbi, functionName: 'balanceOf', args: [wallet] }) as Promise<bigint>,
  ]);
  const value = (await app.client.readContract({ address: app.addresses.pool, abi: MutualPoolAbi, functionName: 'convertToAssets', args: [shares] })) as bigint;
  return { money, shares, value };
}

export interface WithdrawalRow {
  id: number;
  shares: bigint;
  readyAt: number;
  value: bigint;
}

export async function withdrawalsOf(app: App, wallet: Address): Promise<WithdrawalRow[]> {
  const pool = { address: app.addresses.pool, abi: MutualPoolAbi } as const;
  const count = Number(await app.client.readContract({ ...pool, functionName: 'withdrawalCount' }));
  const next = Number(await app.client.readContract({ ...pool, functionName: 'nextWithdrawal' }));
  const rows: WithdrawalRow[] = [];
  for (let id = next; id < count; id++) {
    const [backer, readyAt, shares] = (await app.client.readContract({ ...pool, functionName: 'withdrawalRequests', args: [BigInt(id)] })) as [Address, bigint, bigint];
    if (backer.toLowerCase() !== wallet.toLowerCase()) continue;
    const value = (await app.client.readContract({ ...pool, functionName: 'convertToAssets', args: [shares] })) as bigint;
    rows.push({ id, shares, readyAt: Number(readyAt), value });
  }
  return rows;
}

export interface CoverRow {
  id: number;
  holder: string;
  product_id: number;
  event_key: string;
  ref: string;
  event_time: number;
  premium: string;
  payout: string;
  status: string;
  paid: string;
  sold_at: number;
  ended_at: number | null;
  label: string | null;
  details: string | null;
}

const COVER_SELECT = 'SELECT covers.*, labels.label, labels.details FROM covers LEFT JOIN labels ON labels.ref = covers.ref';

export function coversOf(app: App, wallet: Address): CoverRow[] {
  return app.db.prepare(`${COVER_SELECT} WHERE holder = ? ORDER BY id DESC`).all(wallet.toLowerCase()) as unknown as CoverRow[];
}

export function openCovers(app: App): CoverRow[] {
  return app.db.prepare(`${COVER_SELECT} WHERE status = 'Active' ORDER BY id`).all() as unknown as CoverRow[];
}

export function coverById(app: App, id: number): CoverRow | undefined {
  return app.db.prepare(`${COVER_SELECT} WHERE covers.id = ?`).get(id) as unknown as CoverRow | undefined;
}

export interface Totals {
  sold: number;
  active: number;
  paidOutCount: number;
  paidOut: bigint;
  premiumsEarned: bigint;
  refunded: number;
}

export function coverTotals(app: App): Totals {
  const rows = app.db.prepare('SELECT status, premium, payout, paid FROM covers').all() as { status: string; premium: string; payout: string; paid: string }[];
  const totals: Totals = { sold: rows.length, active: 0, paidOutCount: 0, paidOut: 0n, premiumsEarned: 0n, refunded: 0 };
  for (const row of rows) {
    if (row.status === 'Active' || row.status === 'ClaimOpen') totals.active++;
    if (row.status === 'PaidOut') {
      totals.paidOutCount++;
      totals.paidOut += BigInt(row.paid);
      totals.premiumsEarned += BigInt(row.premium);
    }
    if (row.status === 'Expired') totals.premiumsEarned += BigInt(row.premium) - BigInt(row.paid);
    if (row.status === 'Refunded') totals.refunded++;
  }
  return totals;
}

export async function resultOf(app: App, eventKey: Hex) {
  // Same order as ResultOracle.EventData.
  const [registered, decided, triggered, , , , , value] = (await app.client.readContract({
    address: app.addresses.oracle,
    abi: ResultOracleAbi,
    functionName: 'events',
    args: [eventKey],
  })) as [boolean, boolean, boolean, number, number, number, number, number, number, number, number];
  return { registered, decided, triggered, value };
}

export function sharePriceHistory(app: App) {
  return app.db.prepare('SELECT time, price FROM share_prices ORDER BY time').all() as { time: number; price: number }[];
}

export function productForCover(app: App, cover: CoverRow): ProductConfig {
  return productById(app.decisions, cover.product_id);
}

export async function trackSharePrice(app: App) {
  const [numbers, now] = await Promise.all([poolNumbers(app), chainNow(app.client)]);
  recordSharePrice(app.db, now, numbers.sharePrice, numbers.totalAssets);
}

export async function upcomingFlights(app: App, date: string) {
  const now = await chainNow(app.client);
  const product = app.decisions.products.find((item) => item.key === 'flight-delay')!;
  return flightsOn(date).filter((flight) => flight.departure >= now + product.salesCutoffHours * HOUR);
}

export async function simDate(app: App) {
  return dateOf(await chainNow(app.client));
}

// Membership and identity

export async function isMember(app: App, wallet: Address): Promise<boolean> {
  return (await app.client.readContract({ address: app.addresses.members, abi: MembershipAbi, functionName: 'isMember', args: [wallet] })) as boolean;
}

export async function memberCount(app: App): Promise<number> {
  return Number(await app.client.readContract({ address: app.addresses.members, abi: MembershipAbi, functionName: 'memberCount' }));
}

export async function becomeMember(app: App, user: User, person: { fullName: string; country: string }) {
  const result = await app.identity.check(person);
  if (!result.passed) throw new Error(result.reason ?? "The check didn't pass.");
  const taken = app.db.prepare('SELECT wallet FROM identity_checks WHERE person_hash = ?').get(result.personHash) as { wallet: string } | undefined;
  if (taken && taken.wallet !== user.wallet) throw new Error('This person already has a membership. It is one person, one membership.');
  await send(app.client, roleAccount('verifier'), { address: app.addresses.members, abi: MembershipAbi, functionName: 'add', args: [user.wallet] });
  // Only the hash is kept, not the name.
  app.db
    .prepare('INSERT OR IGNORE INTO identity_checks (person_hash, wallet, checked_at) VALUES (?, ?, ?)')
    .run(result.personHash, user.wallet, Math.floor(Date.now() / 1000));
  countUse(app.db, 'member_joined');
}

// Claims that need judgement. They go to the ladder (see ladder.ts) or, in vote mode, to a member vote.

export async function fileClaim(app: App, user: User, coverId: number, evidence: string) {
  const evidenceHash = keccak256(toBytes(evidence));
  app.db.prepare('INSERT OR IGNORE INTO claim_evidence (evidence_hash, text) VALUES (?, ?)').run(evidenceHash, evidence);
  await send(app.client, userAccount(user), { address: app.addresses.book, abi: CoverBookAbi, functionName: 'fileClaim', args: [BigInt(coverId), evidenceHash] });
  countUse(app.db, 'claim_filed');
  await syncEvents(app.db, app.client, app.addresses);
}

export interface ClaimRow {
  id: number;
  coverId: number;
  holder: Address;
  evidence: string;
  endsAt: number;
  yes: number;
  no: number;
  needed: number;
  finished: boolean;
  label: string | null;
}

export async function listClaims(app: App): Promise<ClaimRow[]> {
  const review = { address: app.addresses.review, abi: ClaimReviewAbi } as const;
  const count = Number(await app.client.readContract({ ...review, functionName: 'claimCount' }));
  const rows: ClaimRow[] = [];
  for (let id = count; id >= 1; id--) {
    const [coverId, holder, evidenceHash, , endsAt, yes, no, needed, finished] = (await app.client.readContract({
      ...review,
      functionName: 'claims',
      args: [BigInt(id)],
    })) as [bigint, Address, Hex, number, number, number, number, number, boolean];
    const evidence = app.db.prepare('SELECT text FROM claim_evidence WHERE evidence_hash = ?').get(evidenceHash) as { text: string } | undefined;
    rows.push({
      id,
      coverId: Number(coverId),
      holder,
      evidence: evidence?.text ?? '(text not found)',
      endsAt,
      yes,
      no,
      needed,
      finished,
      label: coverById(app, Number(coverId))?.label ?? null,
    });
  }
  return rows;
}

export async function voteOnClaim(app: App, account: Account, claimId: number, approve: boolean) {
  await send(app.client, account, { address: app.addresses.review, abi: ClaimReviewAbi, functionName: 'vote', args: [BigInt(claimId), approve] });
}

export async function hasVotedOnClaim(app: App, claimId: number, wallet: Address): Promise<boolean> {
  return (await app.client.readContract({ address: app.addresses.review, abi: ClaimReviewAbi, functionName: 'hasVoted', args: [BigInt(claimId), wallet] })) as boolean;
}

// Member votes on settings

export const VOTABLE_SETTINGS = {
  memberRebateBps: { label: 'Share of each price given back to members with no payout (basis points)', fn: 'setMemberRebateBps' },
  poolCap: { label: 'Pool limit (test dollars)', fn: 'setPoolCap' },
  withdrawalWait: { label: 'Withdrawal wait (days)', fn: 'setWithdrawalWait' },
} as const;

export type VotableSetting = keyof typeof VOTABLE_SETTINGS;

function settingCall(setting: VotableSetting, value: number) {
  const amount = setting === 'poolCap' ? fromUsd(value) : setting === 'withdrawalWait' ? BigInt(value * DAY) : BigInt(value);
  return encodeFunctionData({ abi: MutualPoolAbi as Abi, functionName: VOTABLE_SETTINGS[setting].fn, args: [amount] });
}

export async function proposeChange(app: App, account: Account, setting: VotableSetting, value: number, note: string) {
  const data = settingCall(setting, value);
  const description = `${VOTABLE_SETTINGS[setting].label}: ${value}. ${note}`.trim();
  const descriptionHash = keccak256(toBytes(description));
  app.db.prepare('INSERT OR IGNORE INTO proposal_notes (description_hash, text) VALUES (?, ?)').run(descriptionHash, description);
  await send(app.client, account, { address: app.addresses.governor, abi: MemberGovernorAbi, functionName: 'propose', args: [app.addresses.pool, data, descriptionHash] });
  countUse(app.db, 'proposal');
}

export interface ProposalRow {
  id: number;
  text: string;
  endsAt: number;
  yes: number;
  no: number;
  needed: number;
  queued: boolean;
  executed: boolean;
}

export async function listProposals(app: App): Promise<ProposalRow[]> {
  const governor = { address: app.addresses.governor, abi: MemberGovernorAbi } as const;
  const count = Number(await app.client.readContract({ ...governor, functionName: 'proposalCount' }));
  const rows: ProposalRow[] = [];
  for (let id = count; id >= 1; id--) {
    const row = (await app.client.readContract({ ...governor, functionName: 'proposals', args: [BigInt(id)] })) as unknown as unknown[];
    const [, , , endsAt, yes, no, needed, queued, , descriptionHash] = row as [Address, Address, number, number, number, number, number, boolean, Hex, Hex];
    const note = app.db.prepare('SELECT text FROM proposal_notes WHERE description_hash = ?').get(descriptionHash) as { text: string } | undefined;
    const executed = app.db.prepare("SELECT 1 FROM chain_events WHERE name = 'ProposalExecuted' AND json_extract(args, '$.id') = ?").get(String(id));
    rows.push({ id, text: note?.text ?? '(text not found)', endsAt, yes, no, needed, queued, executed: Boolean(executed) });
  }
  return rows;
}

export async function voteOnProposal(app: App, account: Account, id: number, support: boolean) {
  await send(app.client, account, { address: app.addresses.governor, abi: MemberGovernorAbi, functionName: 'vote', args: [BigInt(id), support] });
}

export async function hasVotedOnProposal(app: App, id: number, wallet: Address): Promise<boolean> {
  return (await app.client.readContract({ address: app.addresses.governor, abi: MemberGovernorAbi, functionName: 'hasVoted', args: [BigInt(id), wallet] })) as boolean;
}

// Team tools, which all go through the multisig and the timelock

export async function setPaused(app: App, paused: boolean) {
  await send(app.client, roleAccount('guardian'), { address: app.addresses.pool, abi: MutualPoolAbi, functionName: 'setPaused', args: [paused] });
}

export async function rejectResult(app: App, eventKey: Hex) {
  await send(app.client, roleAccount('guardian'), { address: app.addresses.oracle, abi: ResultOracleAbi, functionName: 'reject', args: [eventKey] });
}

/** Two local test signers schedule a change on the timelock. It can run after the delay. */
export async function teamSchedule(app: App, setting: VotableSetting, value: number) {
  const data = settingCall(setting, value);
  const salt = keccak256(toBytes(`team:${setting}:${value}:${Date.now()}`));
  const delay = (await app.client.readContract({ address: app.addresses.timelock, abi: TimelockControllerAbi, functionName: 'getMinDelay' })) as bigint;
  const schedule = encodeFunctionData({
    abi: TimelockControllerAbi as Abi,
    functionName: 'schedule',
    args: [app.addresses.pool, 0n, data, `0x${'00'.repeat(32)}`, salt, delay],
  });
  const multisig = { address: app.addresses.multisig, abi: TeamMultisigAbi } as const;
  const { result } = await send(app.client, roleAccount('signer0'), { ...multisig, functionName: 'submit', args: [app.addresses.timelock, schedule] });
  await send(app.client, roleAccount('signer1'), { ...multisig, functionName: 'confirm', args: [result] });
  await send(app.client, roleAccount('signer1'), { ...multisig, functionName: 'execute', args: [result] });
  const now = await chainNow(app.client);
  app.db
    .prepare('INSERT OR REPLACE INTO worker_state (key, value) VALUES (?, ?)')
    .run(`team_change:${salt}`, JSON.stringify({ setting, value, data, salt, readyAt: now + Number(delay) }));
  countUse(app.db, 'team_change');
}

export interface TeamChange {
  setting: VotableSetting;
  value: number;
  data: Hex;
  salt: Hex;
  readyAt: number;
}

export function pendingTeamChanges(app: App): TeamChange[] {
  const rows = app.db.prepare("SELECT value FROM worker_state WHERE key LIKE 'team_change:%'").all() as { value: string }[];
  return rows.map((row) => JSON.parse(row.value));
}

export async function teamExecute(app: App, change: TeamChange) {
  await send(app.client, roleAccount('deployer'), {
    address: app.addresses.timelock,
    abi: TimelockControllerAbi,
    functionName: 'execute',
    args: [app.addresses.pool, 0n, change.data, `0x${'00'.repeat(32)}`, change.salt],
  });
  app.db.prepare('DELETE FROM worker_state WHERE key = ?').run(`team_change:${change.salt}`);
}

// Demo and feedback

export function setDemoResult(app: App, ref: Hex, value: number) {
  app.db.prepare('INSERT INTO demo_results (ref, value) VALUES (?, ?) ON CONFLICT(ref) DO UPDATE SET value = excluded.value').run(ref, value);
}

export function demoResultFor(app: App, ref: Hex): number | null {
  const row = app.db.prepare('SELECT value FROM demo_results WHERE ref = ?').get(ref) as { value: number } | undefined;
  return row?.value ?? null;
}

export function saveFeedback(app: App, rating: number | null, text: string) {
  app.db.prepare('INSERT INTO feedback (created_at, rating, text) VALUES (?, ?, ?)').run(Math.floor(Date.now() / 1000), rating, text.slice(0, 2000));
}

export function usageTotals(app: App) {
  return app.db.prepare('SELECT name, SUM(count) AS count FROM usage_counts GROUP BY name ORDER BY name').all() as { name: string; count: number }[];
}

export function allFeedback(app: App) {
  return app.db.prepare('SELECT created_at, rating, text FROM feedback ORDER BY id DESC LIMIT 100').all() as { created_at: number; rating: number | null; text: string }[];
}
