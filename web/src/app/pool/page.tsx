import { redirect } from 'next/navigation';
import { chainNow, poolNumbers, walletNumbers, withdrawalsOf } from '@openmutual/shared';
import { ActionForm } from '@/components/ActionForm';
import { AutoRefresh } from '@/components/AutoRefresh';
import { deposit, moreTestMoney, withdraw } from '@/lib/actions';
import { dateTime, duration, money } from '@/lib/format';
import { currentUser, syncedApp } from '@/lib/server';

export default async function Pool() {
  const user = await currentUser();
  if (!user) redirect('/login');
  const app = await syncedApp();
  const [numbers, mine, requests, now] = await Promise.all([
    poolNumbers(app),
    walletNumbers(app, user.wallet),
    withdrawalsOf(app, user.wallet),
    chainNow(app.client),
  ]);

  // Money in minus money out, so gain is measured against what this person put in.
  const flows = app.db
    .prepare("SELECT name, args FROM chain_events WHERE name IN ('Deposit', 'Withdraw') AND lower(json_extract(args, '$.owner')) = ?")
    .all(user.wallet.toLowerCase()) as { name: string; args: string }[];
  let netIn = 0n;
  for (const flow of flows) {
    const assets = BigInt(JSON.parse(flow.args).assets);
    netIn += flow.name === 'Deposit' ? assets : -assets;
  }
  const worth = mine.value + requests.reduce((sum, request) => sum + request.value, 0n);
  const gain = worth - netIn;

  return (
    <>
      <AutoRefresh />
      <h1>Back the pool</h1>
      <p className="lead">Your test money stands behind other people&apos;s covers. You share what&apos;s left after payouts.</p>
      <p className="callout warn">
        You can lose money here, as a real backer could. A run of payouts lowers the share price, and nothing is promised. Test money only.
      </p>

      <section className="section stats" aria-label="Your numbers">
        <div className="stat"><span>In your wallet</span><strong>{money(mine.money)}</strong></div>
        <div className="stat"><span>Your part of the pool</span><strong data-testid="pool-value">{money(worth)}</strong></div>
        <div className="stat"><span>Gain or loss so far</span><strong data-testid="pool-gain">{gain < 0n ? '-' : ''}{money(gain < 0n ? -gain : gain)}</strong></div>
        <div className="stat"><span>Share price</span><strong>{numbers.sharePrice.toFixed(4)}</strong></div>
      </section>

      <section className="section split">
        <div className="card">
          <h2>Add test money</h2>
          <ActionForm action={deposit} submit="Deposit">
            <label>
              Amount in test dollars
              <input name="amount" type="number" min="1" step="1" required defaultValue="1000" />
            </label>
          </ActionForm>
        </div>
        <div className="card">
          <h2>Ask to withdraw</h2>
          <p className="small muted">
            The wait is {duration(numbers.withdrawalWait)}, and you can&apos;t cancel it. You get the share price at the end of the
            wait, so you still share any gains or losses until then.
          </p>
          <ActionForm action={withdraw} submit="Start the wait">
            <label>
              Percent of your shares
              <input name="percent" type="number" min="1" max="100" step="1" required defaultValue="100" />
            </label>
          </ActionForm>
        </div>
      </section>

      {requests.length > 0 ? (
        <section className="section card">
          <h2>Your withdrawals in the queue</h2>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Ready</th><th>Status</th><th className="num">Worth now</th></tr></thead>
              <tbody>
                {requests.map((request) => (
                  <tr key={request.id}>
                    <td>{dateTime(request.readyAt)}</td>
                    <td>{request.readyAt > now ? `${duration(request.readyAt - now)} left` : 'Being paid as money frees up'}</td>
                    <td className="num">{money(request.value)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      <section className="section">
        <ActionForm action={moreTestMoney} submit="Get 10,000 more test dollars" quiet />
      </section>
    </>
  );
}
