// A simulated closed test. Made up people buy covers and back the pool for some
// weeks on a throwaway local chain, with outcomes from the fake world. Nobody real
// takes part, so this checks the mechanics and the pricing, not whether people like it.
//
//   npm run simulate                 12 weeks, 20 covers a day
//   npm run simulate -- 4 10         4 weeks, 10 covers a day

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  askToWithdraw,
  buyCover,
  chainNow,
  chance,
  coverTotals,
  createApp,
  createLogger,
  createUser,
  dateOf,
  deployAll,
  depositToPool,
  fakeSources,
  findFlight,
  flightOffer,
  flightsOn,
  friendlyError,
  fromUsd,
  getMoreTestMoney,
  openDb,
  poolNumbers,
  projectRoot,
  publicClient,
  rainOffer,
  citiesList,
  makeQuote,
  NON_FLIGHT_CHANCE,
  skipTime,
  toUsd,
  walletNumbers,
  type User,
} from '@openmutual/shared';
import type { PublicClient } from 'viem';
import { launchChain } from './local-chain';
import { tick } from './tick';

const weeks = Number(process.argv[2] ?? 12);
const perDay = Number(process.argv[3] ?? 20);
const BACKERS = 6;
const BACKER_MONEY = 20_000;
const BUYERS = 30;
const HOUR = 3600;
const DAY = 86_400;

const dir = mkdtempSync(join(tmpdir(), 'openmutual-sim-'));
process.env.DATA_DIR = dir;
process.env.LOG_DIR = dir;
const { child, url } = await launchChain(40_000 + Math.floor(Math.random() * 10_000));
process.env.RPC_URL = url;

try {
  const client = publicClient(url) as PublicClient;
  const app = createApp({ client, addresses: await deployAll(client), db: openDb(join(dir, 'sim.sqlite')) });
  const log = createLogger('simulate');
  log.info = () => {};
  log.warn = () => {};
  const sources = fakeSources();
  const startedAt = Date.now();
  console.log(`Simulating ${weeks} weeks, ${perDay} covers a day...`);

  const backers: User[] = [];
  for (let i = 0; i < BACKERS; i++) {
    const backer = await createUser(app, `backer${i}@sim.local`);
    await getMoreTestMoney(app, backer);
    await depositToPool(app, backer, fromUsd(BACKER_MONEY));
    backers.push(backer);
  }
  const buyers: User[] = [];
  for (let i = 0; i < BUYERS; i++) buyers.push(await createUser(app, `buyer${i}@sim.local`));

  const startPrice = (await poolNumbers(app)).sharePrice;
  const refused = new Map<string, number>();
  let mostLocked = 0;
  let worstDay = { date: '', paid: 0 };
  let paidSoFar = 0;
  const totalDays = weeks * 7;

  for (let day = 0; day < totalDays + 14; day++) {
    const today = dateOf(await chainNow(app.client));
    if (day < totalDays) {
      for (let i = 0; i < perDay; i++) {
        const seed = `sim:${day}:${i}`;
        const buyer = buyers[Math.floor(chance(`${seed}:who`) * BUYERS)];
        const date = dateOf((await chainNow(app.client)) + (3 + Math.floor(chance(`${seed}:when`) * 4)) * DAY);
        const offer =
          chance(`${seed}:what`) < 0.85
            ? flightOffer(app, flightsOn(date)[Math.floor(chance(`${seed}:flight`) * 24)].number, date)
            : rainOffer(app, citiesList()[Math.floor(chance(`${seed}:city`) * citiesList().length)], date);
        try {
          await buyCover(app, buyer, await makeQuote(app, offer, buyer.wallet));
        } catch (error) {
          const reason = friendlyError(error);
          refused.set(reason, (refused.get(reason) ?? 0) + 1);
        }
      }
    }
    // One backer leaves half way, to exercise the queue.
    if (day === Math.floor(totalDays / 2)) {
      const { shares } = await walletNumbers(app, backers[0].wallet);
      await askToWithdraw(app, backers[0], shares / 2n);
    }
    for (let quarter = 0; quarter < 4; quarter++) {
      await skipTime(app.client, 6 * HOUR);
      await tick(app, sources, log);
    }
    const numbers = await poolNumbers(app);
    mostLocked = Math.max(mostLocked, Number(numbers.lockedCapital) / Number(numbers.totalAssets));
    const paidNow = toUsd(coverTotals(app).paidOut);
    if (paidNow - paidSoFar > worstDay.paid) worstDay = { date: today, paid: paidNow - paidSoFar };
    paidSoFar = paidNow;
    if (day % 7 === 6) process.stdout.write(`  week ${Math.ceil((day + 1) / 7)} done\n`);
  }

  // Pricing check: what each risk group was priced at, against what happened.
  const rows = app.db
    .prepare("SELECT covers.status, labels.details FROM covers JOIN labels ON labels.ref = covers.ref WHERE labels.kind = 'flight'")
    .all() as { status: string; details: string }[];
  const groups: Record<string, { sold: number; paid: number }> = { low: { sold: 0, paid: 0 }, middle: { sold: 0, paid: 0 }, high: { sold: 0, paid: 0 } };
  for (const row of rows) {
    const details = JSON.parse(row.details);
    const flight = findFlight(details.subject, details.date);
    if (!flight) continue;
    groups[flight.risk].sold++;
    if (row.status === 'PaidOut') groups[flight.risk].paid++;
  }

  const rain = app.db
    .prepare("SELECT COUNT(*) AS sold, SUM(covers.status = 'PaidOut') AS paid FROM covers JOIN labels ON labels.ref = covers.ref WHERE labels.kind = 'rain'")
    .get() as { sold: number; paid: number | null };

  const totals = coverTotals(app);
  const end = await poolNumbers(app);
  const premiums = toUsd(
    (app.db.prepare("SELECT premium FROM covers WHERE status != 'Refunded'").all() as { premium: string }[]).reduce((sum, row) => sum + BigInt(row.premium), 0n),
  );
  const paid = toUsd(totals.paidOut);
  const lossRatio = premiums > 0 ? paid / premiums : 0;
  const still = totals.active;
  const rates = app.decisions.pricing.riskGroups;
  const minutes = ((Date.now() - startedAt) / 60_000).toFixed(1);
  const pct = (value: number) => `${(value * 100).toFixed(1)}%`;

  const report = `# Simulation results

**This is a simulated closed test, not a real one.** Made up people bought covers and backed the pool on a throwaway local chain. Flights and weather come from the fake world in \`shared/src/sources/fake-world.ts\`, whose late rates are set from public flight delay statistics. So this shows that the mechanics hold up and that the pricing matches the fake world. It says nothing about real flights or real people.

Run with \`npm run simulate -- ${weeks} ${perDay}\`. Last run took ${minutes} minutes.

## Setup

| | |
| --- | --- |
| Length | ${weeks} weeks of selling, then 2 weeks to let everything settle |
| Covers tried | ${perDay} a day, 85% late flight and 15% rainy day |
| Backers | Starter money of ${app.decisions.pool.starterMoneyUsd.toLocaleString('en-GB')} plus ${BACKERS} backers with ${BACKER_MONEY.toLocaleString('en-GB')} each. One asks to withdraw half, half way through |
| Pricing | ${app.pricing.name}, margin ${pct(app.decisions.pricing.margin)}, chances low ${pct(rates.low)}, middle ${pct(rates.middle)}, high ${pct(rates.high)} |

## What happened

| | |
| --- | --- |
| Covers sold | ${totals.sold} |
| Paid out | ${totals.paidOutCount} covers, ${paid.toFixed(2)} tUSD |
| Refunded because no result came | ${totals.refunded} |
| Still open at the end | ${still} |
| Prices taken in (not counting refunds) | ${premiums.toFixed(2)} tUSD |
| Payouts as a share of prices | ${pct(lossRatio)} |
| Share price | ${startPrice.toFixed(4)} at the start, ${end.sharePrice.toFixed(4)} at the end (${pct(end.sharePrice / startPrice - 1)}) |
| Most of backers' money locked at once | ${pct(mostLocked)} |
| Worst day | ${worstDay.date || 'none'}, ${worstDay.paid.toFixed(2)} tUSD paid out |
| Withdrawals still waiting | ${end.pendingWithdrawals} |

## Pricing against what happened

| Cover | Priced at | Covers | Paid out | Actual rate |
| --- | --- | --- | --- | --- |
${(['low', 'middle', 'high'] as const)
  .map((group) => `| Late flight, ${group} risk | ${pct(rates[group])} | ${groups[group].sold} | ${groups[group].paid} | ${groups[group].sold ? pct(groups[group].paid / groups[group].sold) : 'n/a'} |`)
  .join('\n')}
| Rainy day | ${pct(NON_FLIGHT_CHANCE['rainy-day'])} | ${rain.sold} | ${rain.paid ?? 0} | ${rain.sold ? pct((rain.paid ?? 0) / rain.sold) : 'n/a'} |

Small groups swing a lot. A few hundred covers per group is not enough to prove a rate, which is also true of a real closed test.

## Covers turned down

${refused.size === 0 ? 'None.' : [...refused.entries()].map(([reason, count]) => `- ${reason} (${count})`).join('\n')}

## Checks

- The pool could pay every promise at every point. The contracts refuse any sale that would break this, and the random contract tests try to break it.
- Every withdrawal was paid by the end: ${end.pendingWithdrawals === 0 ? 'yes' : 'no'}.
`;

  writeFileSync(join(projectRoot(), 'docs/SIMULATION-RESULTS.md'), report);
  console.log(report);
} finally {
  child.kill('SIGKILL');
  rmSync(dir, { recursive: true, force: true });
}
