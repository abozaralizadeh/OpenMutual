import Link from 'next/link';
import { coverTotals, memberCount, poolNumbers } from '@openmutual/shared';
import { money } from '@/lib/format';
import { syncedApp } from '@/lib/server';

export default async function Home() {
  const app = await syncedApp();
  const [numbers, members] = await Promise.all([poolNumbers(app), memberCount(app)]);
  const totals = coverTotals(app);

  return (
    <>
      <h1>What if the people paying in could earn too?</h1>
      <p className="lead">
        A mutual where anyone can stand behind the risk and share what&apos;s left after payouts, with the rules and the money in
        public code and no single company in the middle. This is a working simulation of that idea, played with test money.
      </p>
      <div className="row">
        <Link href="/login" className="button">Try it with test money</Link>
        <Link href="/numbers" className="button quiet">See the pool</Link>
      </div>

      <section className="section stats" aria-label="The pool right now">
        <div className="stat"><span>Money in the pool</span><strong>{money(numbers.totalAssets)}</strong></div>
        <div className="stat"><span>Test covers sold</span><strong>{totals.sold}</strong></div>
        <div className="stat"><span>Paid out so far</span><strong>{money(totals.paidOut)}</strong></div>
        <div className="stat"><span>Members</span><strong>{members}</strong></div>
      </section>

      <section className="section split">
        <div className="card">
          <h2>Two ways to take part</h2>
          <p><strong>Get test cover.</strong> Pay a small price. If the rule is met, say your flight lands 3 hours late, the payout arrives by itself.</p>
          <p><strong>Back the pool.</strong> Put test money in. What&apos;s left of the prices after payouts raises your share. A bad run lowers it, so you can lose.</p>
          <p>One person can do both.</p>
        </div>
        <div className="card">
          <h2>How it plays out</h2>
          <ol className="steps">
            <li>Sign in with an email and get 10,000 test dollars.</li>
            <li>Back the pool, buy a test cover, or both.</li>
            <li>Use the clock at the top to skip ahead days at a time.</li>
            <li>Results come in from fake data sources. Covers settle by themselves.</li>
            <li>Ask to withdraw, wait the 7 simulated days, and see how you did.</li>
          </ol>
        </div>
      </section>

      <section className="section card">
        <h2>What this isn&apos;t</h2>
        <p>
          It isn&apos;t a product you can buy. No real money goes in or out, flights and weather are made up, and nobody is promised
          anything. Whether a real version could exist depends on legal work that hasn&apos;t happened.
        </p>
      </section>
    </>
  );
}
