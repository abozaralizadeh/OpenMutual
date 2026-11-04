# Claims results: member vote and claims ladder

A simulation on a throwaway local chain with test money. 6 weeks, 5 made up lost bag claims a day, 210 claims in all. The same claims went through both designs.

The judges are local fakes with known habits. Six fake AI assessors from five makers get 4 to 6% of claims wrong, with mistakes that overlap, and one of them (Northwind) follows orders planted in a claim. The 20 pretend people get 1 in 10 claims wrong.
In the vote, 60% of them turn up to each vote. On a jury, 10% miss their answer.
So this checks the mechanics and how the two designs compare under those habits. It says nothing about how real people or real AI models behave.

Made with `npm run simulate:claims -- 6 5`. It took 1121 seconds.

## Side by side

| | Member vote | Claims ladder |
|---|---|---|
| Claims | 210 | 210 |
| Right answer | 87.1% | 100.0% |
| Paid when it should not have | 0 (0.0%) | 0 (0.0%) |
| Turned down when it should have paid | 27 (12.9%) | 0 (0.0%) |
| No decision, price refunded | 0 | 0 |
| Still open at the end | 0 | 0 |
| Answers from people | 2520 (12.0 a claim) | 750 (3.6 a claim) |
| Average days from claim to settled | 3.0 | 2.8 |

"Right" means the answer a careful reader of the cover wording would reach, with doubt going to the claimant.

Every claim the vote got wrong was an unclear one. A vote is yes or no and needs more yes than no, so when people are unsure the claimant loses. The ladder lets judges say "not clear" and counts that for paying.

## By kind of claim

| Kind | Claims | Member vote right | Claims ladder right |
|---|---|---|---|
| Honest, should pay | 118 | 100.0% | 100.0% |
| Unclear, doubt pays | 31 | 12.9% | 100.0% |
| Says it was made up | 19 | 100.0% | 100.0% |
| Carry-on bag, not covered | 18 | 100.0% | 100.0% |
| Gives orders to the AI | 24 | 100.0% | 100.0% |

## Where the ladder settled claims

| Step | Claims |
|---|---|
| AI panel agreed, nobody challenged | 111 (52.9%) |
| Jury | 86 (41.0%) |
| Appeal jury | 13 (6.2%) |
| No decision | 0 |

Challenges: 34. Appeals: 13.

## Hidden tests and the assessors

Hidden test claims: 13, alongside the real ones. 13 of them showed themselves before paying. They're left out of the tables above.

| Assessor | Maker | Reputation | Tests passed | Tests failed | Bond left | Benched |
|---|---|---|---|---|---|---|
| Kestrel A | Kestrel | 280 | 12 | 1 | 900.00 | no |
| Kestrel B | Kestrel | 274 | 11 | 1 | 900.00 | no |
| Sable | Sable | 230 | 10 | 2 | 810.00 | no |
| Ash | Ash | 264 | 10 | 1 | 900.00 | no |
| Moss | Moss | 235 | 11 | 2 | 810.00 | no |
| Northwind | Northwind | 68 | 2 | 2 | 810.00 | day 12 |

Bonds lost to the pool, from failed tests, missed answers and pushback that didn't change the answer: 1723.54 test dollars.

## Limits

- Everything here comes from fakes. The fake assessors read claims with keyword rules, so the numbers show what the ladder does with judges like these, not what real models would do.
- The hidden tests use the same kinds of text as the real claims. Real tests would need care so they look like real claims.
- On a public chain the auditor locks in a test just before it is filed, and that timing could give tests away. A real version would lock tests in batches, well before.
- Judges earn reputation only, no fee. A real version would need to pay them, the same for a yes and a no.
