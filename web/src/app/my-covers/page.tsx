import Link from 'next/link';
import { redirect } from 'next/navigation';
import { chainNow, coversOf, describeValue, ladderClaimForCover, ladderOn, ladderSettingsNow, productForCover, resultOf } from '@openmutual/shared';
import type { Hex } from 'viem';
import { ActionForm } from '@/components/ActionForm';
import { AutoRefresh } from '@/components/AutoRefresh';
import { LadderSteps } from '@/components/LadderSteps';
import { appeal, challenge, submitClaim } from '@/lib/actions';
import { dateTime, money, STATUS_WORDS } from '@/lib/format';
import { currentUser, syncedApp } from '@/lib/server';

export default async function MyCovers() {
  const user = await currentUser();
  if (!user) redirect('/login');
  const app = await syncedApp();

  const ladder = ladderOn(app);
  const [now, settings] = await Promise.all([chainNow(app.client), ladder ? ladderSettingsNow(app) : null]);
  const rows = await Promise.all(
    coversOf(app, user.wallet).map(async (cover) => {
      const product = productForCover(app, cover);
      const result = product.kind === 'automatic' ? await resultOf(app, cover.event_key as Hex) : null;
      const claim = ladder && product.kind === 'reviewed' ? await ladderClaimForCover(app, cover.id) : null;
      return { cover, product, result, claim };
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
          {rows.map(({ cover, product, result, claim }) => (
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
              {claim ? (
                <div className="stack" style={{ gap: 8 }}>
                  <blockquote style={{ margin: 0 }}>{claim.evidence}</blockquote>
                  <LadderSteps claim={claim} now={now} />
                  {claim.stage === 'Challenge' && claim.panelVerdict === 'deny' && claim.windowEnds > now ? (
                    <ActionForm action={challenge} submit="Challenge, it's free" quiet>
                      <input type="hidden" name="id" value={claim.id} />
                      <p className="small muted" style={{ margin: 0 }}>Don&apos;t agree? A random jury of members will look at it again.</p>
                    </ActionForm>
                  ) : null}
                  {claim.stage === 'AppealWindow' && claim.juryVerdict === 'deny' && claim.windowEnds > now && settings ? (
                    <ActionForm action={appeal} submit={`Appeal for ${money(settings.appealBond)}`} quiet>
                      <input type="hidden" name="id" value={claim.id} />
                      <p className="small muted" style={{ margin: 0 }}>A bigger jury decides, once, and that answer is final. You get the bond back if it changes the answer.</p>
                    </ActionForm>
                  ) : null}
                </div>
              ) : null}
              {cover.status === 'Active' && product.kind === 'reviewed' ? (
                <details>
                  <summary>Something went wrong? File a claim</summary>
                  <ActionForm action={submitClaim} submit={ladder ? 'Send the claim' : 'Send to members'}>
                    <input type="hidden" name="coverId" value={cover.id} />
                    <label>
                      What happened?
                      <textarea name="evidence" rows={3} required placeholder="Members will see this. Leave out personal details." />
                    </label>
                    {product.wording ? <p className="small muted" style={{ margin: 0 }}>What it pays for: {product.wording}</p> : null}
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
