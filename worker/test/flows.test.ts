import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  askToWithdraw,
  bagOffer,
  buyCover,
  CANCELLED,
  chainNow,
  coverById,
  coverTotals,
  createUser,
  dateOf,
  depositToPool,
  fakeSource,
  fakeSources,
  fileClaim,
  flightOffer,
  flightRef,
  flightsOn,
  friendlyError,
  fromUsd,
  listClaims,
  listProposals,
  makeQuote,
  openDb,
  pendingTeamChanges,
  poolNumbers,
  proposeChange,
  rainOffer,
  rejectResult,
  resultOf,
  setDemoResult,
  setPaused,
  skipTime,
  syncEvents,
  teamExecute,
  teamSchedule,
  toUsd,
  userAccount,
  walletNumbers,
  becomeMember,
  type ResultSource,
} from '@openmutual/shared';
import { join } from 'node:path';
import { startHarness, type Harness } from './harness';
import { seedSimulatedMembers } from '../src/seed';
import { demoResults, tick } from '../src/tick';

const DAY = 86_400;
const HOUR = 3600;

describe('the whole product on a real local chain', () => {
  let h: Harness;
  let sources: ResultSource[];
  let nextEmail = 0;

  const newUser = () => createUser(h.app, `person${++nextEmail}@test.local`);
  const run = (list = sources, simulated = false) => tick(h.app, list, h.log, { simulatedMembers: simulated });

  /** A date a few days ahead, unique to the caller so flights don't overlap between tests. */
  async function dayAhead(days = 3) {
    return dateOf((await chainNow(h.app.client)) + days * DAY);
  }

  beforeAll(async () => {
    h = await startHarness();
    sources = fakeSources(demoResults(h.app));
    await seedSimulatedMembers(h.app);
  });
  afterAll(() => h.stop());

  async function buyFlight(user: Awaited<ReturnType<typeof newUser>>, date: string, index = 0) {
    const flight = flightsOn(date)[index];
    const quote = await makeQuote(h.app, flightOffer(h.app, flight.number, date), user.wallet);
    return { id: await buyCover(h.app, user, quote), flight, quote };
  }

  async function passAndRun(seconds: number) {
    await skipTime(h.app.client, seconds);
    await run();
  }

  it('starts with the starter money and a fair share price', async () => {
    const numbers = await poolNumbers(h.app);
    expect(toUsd(numbers.totalAssets)).toBe(100_000);
    expect(numbers.sharePrice).toBeCloseTo(1, 3);
    expect(numbers.lockedCapital).toBe(0n);
  });

  it('gives a new person a wallet with test money, once', async () => {
    const first = await createUser(h.app, 'Same@Test.local');
    const again = await createUser(h.app, 'same@test.local ');
    expect(again.wallet).toBe(first.wallet);
    expect(toUsd((await walletNumbers(h.app, first.wallet)).money)).toBe(10_000);
  });

  it('pays a member automatically when a flight is late', async () => {
    const user = await newUser();
    const date = await dayAhead();
    const { id, flight, quote } = await buyFlight(user, date, 1);
    setDemoResult(h.app, flightRef(flight.number, date), 240);
    const before = (await walletNumbers(h.app, user.wallet)).money;

    await skipTime(h.app.client, flight.departure - (await chainNow(h.app.client)) + 60);
    await run();
    expect(coverById(h.app, id)?.status).toBe('Active'); // challenge window
    const result = await resultOf(h.app, coverById(h.app, id)!.event_key as `0x${string}`);
    expect(result).toMatchObject({ decided: true, triggered: true, value: 240 });

    await passAndRun(HOUR + 60);
    const cover = coverById(h.app, id)!;
    expect(cover.status).toBe('PaidOut');
    expect(BigInt(cover.paid)).toBe(BigInt(quote.quote.payout));
    expect((await walletNumbers(h.app, user.wallet)).money - before).toBe(BigInt(quote.quote.payout));
  });

  it('adds the premium to the pool when a flight is on time', async () => {
    const user = await newUser();
    const date = await dayAhead();
    const { id, flight, quote } = await buyFlight(user, date, 2);
    setDemoResult(h.app, flightRef(flight.number, date), 12);
    const before = await poolNumbers(h.app);

    await skipTime(h.app.client, flight.departure - (await chainNow(h.app.client)) + 60);
    await run();
    await passAndRun(HOUR + 60);

    expect(coverById(h.app, id)?.status).toBe('Expired');
    const after = await poolNumbers(h.app);
    expect(after.totalAssets - before.totalAssets).toBe(BigInt(quote.quote.premium));
    expect(after.sharePrice).toBeGreaterThan(before.sharePrice);
  });

  it('a cancelled flight pays too', async () => {
    const user = await newUser();
    const date = await dayAhead();
    const { id, flight } = await buyFlight(user, date, 3);
    setDemoResult(h.app, flightRef(flight.number, date), CANCELLED);
    await skipTime(h.app.client, flight.departure - (await chainNow(h.app.client)) + 60);
    await run();
    await passAndRun(HOUR + 60);
    expect(coverById(h.app, id)?.status).toBe('PaidOut');
  });

  it('one lying source is outvoted', async () => {
    const liar: ResultSource = { name: 'liar', read: async (query, now) => ((await sources[1].read(query, now)) === null ? null : 999) };
    const user = await newUser();
    const date = await dayAhead();
    const { id, flight } = await buyFlight(user, date, 4);
    setDemoResult(h.app, flightRef(flight.number, date), 20);
    await skipTime(h.app.client, flight.departure - (await chainNow(h.app.client)) + 60);
    const list = [liar, sources[1], sources[2]];
    await run(list);
    await skipTime(h.app.client, HOUR + 60);
    await run(list);
    expect(coverById(h.app, id)?.status).toBe('Expired');
  });

  it('keeps going when one source is down', async () => {
    const down: ResultSource = { name: 'down', read: async () => { throw new Error('offline'); } };
    const user = await newUser();
    const date = await dayAhead();
    const { id, flight } = await buyFlight(user, date, 5);
    setDemoResult(h.app, flightRef(flight.number, date), 200);
    await skipTime(h.app.client, flight.departure - (await chainNow(h.app.client)) + 60);
    const list = [down, sources[1], sources[2]];
    await run(list);
    await skipTime(h.app.client, HOUR + 60);
    await run(list);
    expect(coverById(h.app, id)?.status).toBe('PaidOut');
  });

  it('refunds the premium if no result ever comes', async () => {
    const silent: ResultSource = { name: 'silent', read: async () => null };
    const user = await newUser();
    const date = await dayAhead();
    const { id, flight, quote } = await buyFlight(user, date, 6);
    const before = (await walletNumbers(h.app, user.wallet)).money;
    await skipTime(h.app.client, flight.departure - (await chainNow(h.app.client)) + 8 * DAY);
    await run([silent, silent, silent]);
    expect(coverById(h.app, id)?.status).toBe('Refunded');
    expect((await walletNumbers(h.app, user.wallet)).money - before).toBe(BigInt(quote.quote.premium));
  });

  it('lets the guardian stop a wrong result inside the window', async () => {
    const user = await newUser();
    const date = await dayAhead();
    const { id, flight } = await buyFlight(user, date, 7);
    setDemoResult(h.app, flightRef(flight.number, date), 500);
    await skipTime(h.app.client, flight.departure - (await chainNow(h.app.client)) + 60);
    await run();
    await rejectResult(h.app, coverById(h.app, id)!.event_key as `0x${string}`);

    setDemoResult(h.app, flightRef(flight.number, date), 5);
    await run();
    await skipTime(h.app.client, HOUR + 60);
    await run();
    expect(coverById(h.app, id)?.status).toBe('Expired');
  });

  it('settles a rainy day from fake weather data', async () => {
    const user = await newUser();
    const date = await dayAhead(5);
    const quote = await makeQuote(h.app, rainOffer(h.app, 'Rome', date), user.wallet);
    const id = await buyCover(h.app, user, quote);
    await skipTime(h.app.client, 6 * DAY);
    await run();
    await passAndRun(HOUR + 60);
    expect(['PaidOut', 'Expired']).toContain(coverById(h.app, id)?.status);
  });

  it('pays a backer back after the wait, with the share price at that time', async () => {
    const user = await newUser();
    await depositToPool(h.app, user, fromUsd(1_000));
    const { shares, value } = await walletNumbers(h.app, user.wallet);
    expect(toUsd(value)).toBeCloseTo(1_000, 1);
    await askToWithdraw(h.app, user, shares);
    const before = (await walletNumbers(h.app, user.wallet)).money;

    await passAndRun(HOUR);
    expect((await walletNumbers(h.app, user.wallet)).money).toBe(before);

    await passAndRun(7 * DAY);
    const gained = toUsd((await walletNumbers(h.app, user.wallet)).money - before);
    expect(gained).toBeGreaterThan(990);
    expect((await poolNumbers(h.app)).pendingWithdrawals).toBe(0);
  });

  it('stops sales when paused, and the message reads well', async () => {
    const user = await newUser();
    const date = await dayAhead();
    await setPaused(h.app, true);
    await expect(buyFlight(user, date, 8)).rejects.toSatisfy((error) => friendlyError(error) === 'New covers are paused right now.');
    await setPaused(h.app, false);
  });

  it('turns down a price that has expired', async () => {
    const user = await newUser();
    const date = await dayAhead(5);
    const quote = await makeQuote(h.app, flightOffer(h.app, flightsOn(date)[9].number, date), user.wallet);
    await skipTime(h.app.client, 11 * 60);
    await expect(buyCover(h.app, user, quote)).rejects.toSatisfy((error) => friendlyError(error) === 'This price has expired. Get a new one.');
  });

  it('runs a lost bag claim through a member vote', async () => {
    const user = await newUser();
    const date = await dayAhead(2);
    const quote = await makeQuote(h.app, bagOffer(h.app, user.wallet, date), user.wallet);
    const id = await buyCover(h.app, user, quote);
    await fileClaim(h.app, user, id, 'My bag never came off the belt in Rome.');
    await skipTime(h.app.client, 60);
    await run(sources, true);
    const [claim] = await listClaims(h.app);
    expect(claim.yes).toBe(5);

    await skipTime(h.app.client, 3 * DAY + 60);
    await run(sources, true);
    expect(coverById(h.app, id)?.status).toBe('PaidOut');
  });

  it('turns down a claim members vote against', async () => {
    const user = await newUser();
    const date = await dayAhead(2);
    const id = await buyCover(h.app, user, await makeQuote(h.app, bagOffer(h.app, user.wallet, date), user.wallet));
    await fileClaim(h.app, user, id, 'This one is fake.');
    await skipTime(h.app.client, 60);
    await run(sources, true);
    await skipTime(h.app.client, 3 * DAY + 60);
    await run(sources, true);
    expect(coverById(h.app, id)?.status).toBe('Expired');
  });

  it('a bag cover with no claim ends after the claim window', async () => {
    const user = await newUser();
    const date = await dayAhead(1);
    const id = await buyCover(h.app, user, await makeQuote(h.app, bagOffer(h.app, user.wallet, date), user.wallet));
    await passAndRun(9 * DAY);
    expect(coverById(h.app, id)?.status).toBe('Expired');
  });

  it('holds one membership per person', async () => {
    const a = await newUser();
    const b = await newUser();
    await becomeMember(h.app, a, { fullName: 'Test Person', country: 'Italy' });
    await expect(becomeMember(h.app, b, { fullName: ' test  person', country: 'italy' })).rejects.toThrow('one person, one membership');
    await expect(becomeMember(h.app, b, { fullName: 'Blocked Name', country: 'Italy' })).rejects.toThrow('turned this name down');
  });

  it('members can vote a setting through, and it applies after the delay', async () => {
    const user = await newUser();
    await becomeMember(h.app, user, { fullName: 'Voter One', country: 'Italy' });
    await proposeChange(h.app, userAccount(user), 'memberRebateBps', 500, 'Give a little back.');
    await skipTime(h.app.client, 60);
    await run(sources, true);
    const [proposal] = await listProposals(h.app);
    expect(proposal.yes).toBe(5);

    await skipTime(h.app.client, 3 * DAY + 60);
    await run(sources, true);
    expect((await listProposals(h.app))[0].queued).toBe(true);
    expect((await poolNumbers(h.app)).memberRebateBps).toBe(0);

    await skipTime(h.app.client, DAY + 60);
    await run(sources, true);
    expect((await poolNumbers(h.app)).memberRebateBps).toBe(500);
    expect((await listProposals(h.app))[0].executed).toBe(true);
  });

  it('a voted down proposal changes nothing', async () => {
    const user = await newUser();
    await becomeMember(h.app, user, { fullName: 'Voter Two', country: 'Italy' });
    await proposeChange(h.app, userAccount(user), 'poolCap', 5, 'Please reject this.');
    await skipTime(h.app.client, 60);
    await run(sources, true);
    await skipTime(h.app.client, 5 * DAY);
    await run(sources, true);
    expect((await listProposals(h.app))[0].queued).toBe(false);
    expect(toUsd((await poolNumbers(h.app)).poolCap)).toBe(1_000_000);
  });

  it('team changes need the delay', async () => {
    await teamSchedule(h.app, 'withdrawalWait', 10);
    const [change] = pendingTeamChanges(h.app);
    await expect(teamExecute(h.app, change)).rejects.toThrow();
    await skipTime(h.app.client, DAY + 60);
    await teamExecute(h.app, change);
    expect((await poolNumbers(h.app)).withdrawalWait).toBe(10 * DAY);
    expect(pendingTeamChanges(h.app)).toHaveLength(0);
  });

  it('every promise is covered by money in the pool', async () => {
    const numbers = await poolNumbers(h.app);
    const owed = (h.app.db.prepare("SELECT payout FROM covers WHERE status IN ('Active', 'ClaimOpen')").all() as { payout: string }[]).reduce(
      (sum, row) => sum + BigInt(row.payout),
      0n,
    );
    expect(numbers.lockedCapital + numbers.unearnedPremiums).toBe(owed);
    expect(numbers.balance).toBeGreaterThanOrEqual(owed);
  });

  it('the page numbers match the chain, and the database can be rebuilt from it', async () => {
    await run();
    const fresh = { ...h.app, db: openDb(join(h.dir, 'rebuilt.sqlite')) };
    await syncEvents(fresh.db, fresh.client, fresh.addresses);
    expect(coverTotals(fresh)).toEqual(coverTotals(h.app));
    expect(coverTotals(fresh).sold).toBeGreaterThan(10);

    // Money check: start + premiums earned - payouts = what the chain says backers hold.
    const totals = coverTotals(h.app);
    const flows = h.app.db.prepare("SELECT name, args FROM chain_events WHERE name IN ('Deposit', 'Withdraw')").all() as { name: string; args: string }[];
    let net = 0n;
    for (const flow of flows) {
      const assets = BigInt(JSON.parse(flow.args).assets);
      net += flow.name === 'Deposit' ? assets : -assets;
    }
    const numbers = await poolNumbers(h.app);
    expect(numbers.totalAssets).toBe(net + totals.premiumsEarned - totals.paidOut);
  });
});
