import { coverTotals, poolNumbers, sharePriceHistory } from '@openmutual/shared';
import { AutoRefresh } from '@/components/AutoRefresh';
import { LineChart } from '@/components/LineChart';
import { dateTime, money } from '@/lib/format';
import { syncedApp } from '@/lib/server';

export default async function Numbers() {
  const app = await syncedApp();
  const numbers = await poolNumbers(app);
  const totals = coverTotals(app);
  const owed = numbers.lockedCapital + numbers.unearnedPremiums;
  const lockedShare = numbers.totalAssets > 0n ? Number((numbers.lockedCapital * 1000n) / numbers.totalAssets) / 10 : 0;
  const recent = app.db
    .prepare(
      `SELECT covers.id, covers.paid, covers.ended_at, labels.label FROM covers LEFT JOIN labels ON labels.ref = covers.ref
       WHERE status = 'PaidOut' ORDER BY ended_at DESC LIMIT 10`,
    )
    .all() as { id: number; paid: string; ended_at: number; label: string | null }[];

  return (
    <>
      <AutoRefresh seconds={6} />
      <h1>Pool numbers</h1>
      <p className="lead">Every number here comes from the local chain, so anyone can check it.</p>

      <section className="stats" aria-label="Totals">
        <div className="stat"><span>Backers&apos; money</span><strong data-testid="total-assets">{money(numbers.totalAssets)}</strong></div>
        <div className="stat"><span>Free to use</span><strong>{money(numbers.freeCapital)}</strong></div>
        <div className="stat"><span>Promised on active covers</span><strong>{money(owed)}</strong></div>
        <div className="stat"><span>Test covers sold</span><strong data-testid="covers-sold">{totals.sold}</strong></div>
        <div className="stat"><span>Prices taken in, on ended covers</span><strong>{money(totals.premiumsEarned)}</strong></div>
        <div className="stat"><span>Paid out</span><strong data-testid="paid-out">{money(totals.paidOut)}</strong></div>
      </section>

      <section className="section card">
        <h2>Can the pool pay what it promised?</h2>
        <p>
          Yes. It holds <strong>{money(numbers.balance)}</strong> and has promised <strong>{money(owed)}</strong>. Every cover keeps its
          full payout locked until it ends, and sales stop when there&apos;s no free money left.
        </p>
        <div className="bar" role="img" aria-label={`${lockedShare}% of backers' money is locked`}>
          <i style={{ width: `${lockedShare}%` }} />
        </div>
        <p className="small muted" style={{ marginTop: 6 }}>{lockedShare}% of backers&apos; money is locked.</p>
      </section>

      <section className="section card">
        <h2>Share price</h2>
        <LineChart points={sharePriceHistory(app)} />
      </section>

      {recent.length > 0 ? (
        <section className="section card">
          <h2>Latest payouts</h2>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Cover</th><th>When</th><th className="num">Paid</th></tr></thead>
              <tbody>
                {recent.map((row) => (
                  <tr key={row.id}>
                    <td>{row.label ?? `Cover ${row.id}`}</td>
                    <td>{dateTime(row.ended_at)}</td>
                    <td className="num">{money(row.paid)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
    </>
  );
}
