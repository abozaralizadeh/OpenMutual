import Link from 'next/link';
import { redirect } from 'next/navigation';
import { coversOf, describeValue, productForCover, resultOf } from '@openmutual/shared';
import type { Hex } from 'viem';
import { ActionForm } from '@/components/ActionForm';
import { AutoRefresh } from '@/components/AutoRefresh';
import { submitClaim } from '@/lib/actions';
import { dateTime, money, STATUS_WORDS } from '@/lib/format';
import { currentUser, syncedApp } from '@/lib/server';

export default async function MyCovers() {
  const user = await currentUser();
  if (!user) redirect('/login');
  const app = await syncedApp();

  const rows = await Promise.all(
    coversOf(app, user.wallet).map(async (cover) => {
      const product = productForCover(app, cover);
      const result = product.kind === 'automatic' ? await resultOf(app, cover.event_key as Hex) : null;
      return { cover, product, result };
    }),
  );

  return (
    <>
      <AutoRefresh />
      <h1>My covers</h1>
      {rows.length === 0 ? (
        <p>Nothing yet. <Link href="/cover">Get a test cover</Link>.</p>
      ) : (
        <div className="stack">
          {rows.map(({ cover, product, result }) => (
            <article key={cover.id} className="card" data-testid={`cover-${cover.id}`}>
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <h2 style={{ margin: 0 }}>{cover.label ?? product.name}</h2>
                <span className={`tag ${cover.status}`} data-testid="status">{STATUS_WORDS[cover.status]}</span>
              </div>
              <p className="muted small" style={{ marginTop: 6 }}>
                {product.name}, paid {money(cover.premium)} for a payout of {money(cover.payout)}. Event time {dateTime(cover.event_time)}.
              </p>
              {result?.decided ? (
                <p className="small">
                  Result: {describeValue(product.key, result.value)}.
                  {cover.status === 'Active' ? ' There is a 1 hour check before it settles.' : null}
                </p>
              ) : null}
              {cover.status === 'Active' && !result?.decided && product.kind === 'automatic' ? (
                <p className="small muted">Waiting for the result. Skip the clock ahead to get there.</p>
              ) : null}
              {BigInt(cover.paid) > 0n ? <p className="small"><strong>{money(cover.paid)}</strong> went to your wallet.</p> : null}
              {cover.status === 'Active' && product.kind === 'reviewed' ? (
                <details>
                  <summary>Something went wrong? File a claim</summary>
                  <ActionForm action={submitClaim} submit="Send to members">
                    <input type="hidden" name="coverId" value={cover.id} />
                    <label>
                      What happened?
                      <textarea name="evidence" rows={3} required placeholder="Members will see this. Leave out personal details." />
                    </label>
                  </ActionForm>
                </details>
              ) : null}
            </article>
          ))}
        </div>
      )}
    </>
  );
}
