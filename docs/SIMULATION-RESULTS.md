# Simulation results

**This is a simulated closed test, not a real one.** Made up people bought covers and backed the pool on a throwaway local chain. Flights and weather come from the fake world in `shared/src/sources/fake-world.ts`, whose late rates are set from public flight delay statistics. So this shows that the mechanics hold up and that the pricing matches the fake world. It says nothing about real flights or real people.

Run with `npm run simulate -- 12 20`. Last run took 31.7 minutes.

## Setup

| | |
| --- | --- |
| Length | 12 weeks of selling, then 2 weeks to let everything settle |
| Covers tried | 20 a day, 85% late flight and 15% rainy day |
| Backers | Starter money of 100,000 plus 6 backers with 20,000 each. One asks to withdraw half, half way through |
| Pricing | table, margin 60.0%, chances low 1.0%, middle 2.5%, high 5.0% |

## What happened

| | |
| --- | --- |
| Covers sold | 1680 |
| Paid out | 69 covers, 5050.00 tUSD |
| Refunded because no result came | 0 |
| Still open at the end | 0 |
| Prices taken in (not counting refunds) | 8365.60 tUSD |
| Payouts as a share of prices | 60.4% |
| Share price | 1.0000 at the start, 1.0155 at the end (1.5%) |
| Most of backers' money locked at once | 3.9% |
| Worst day | 2026-11-28, 400.00 tUSD paid out |
| Withdrawals still waiting | 0 |

## Pricing against what happened

| Cover | Priced at | Covers | Paid out | Actual rate |
| --- | --- | --- | --- | --- |
| Late flight, low risk | 1.0% | 594 | 5 | 0.8% |
| Late flight, middle risk | 2.5% | 417 | 12 | 2.9% |
| Late flight, high risk | 5.0% | 422 | 15 | 3.6% |
| Rainy day | 12.0% | 247 | 37 | 15.0% |

Small groups swing a lot. A few hundred covers per group is not enough to prove a rate, which is also true of a real closed test.

## Covers turned down

None.

## Checks

- The pool could pay every promise at every point. The contracts refuse any sale that would break this, and the random contract tests try to break it.
- Every withdrawal was paid by the end: yes.
