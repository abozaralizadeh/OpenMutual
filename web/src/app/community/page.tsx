import { chainNow, hasVotedOnClaim, hasVotedOnProposal, isMember, listClaims, listProposals, memberCount, poolNumbers, toUsd, VOTABLE_SETTINGS } from '@openmutual/shared';
import { ActionForm } from '@/components/ActionForm';
import { AutoRefresh } from '@/components/AutoRefresh';
import { claimVote, join, proposalVote, propose, type ActionState } from '@/lib/actions';
import { dateTime, duration } from '@/lib/format';
import { currentUser, syncedApp } from '@/lib/server';

function VoteButtons({ action, id }: { action: (state: ActionState, form: FormData) => Promise<ActionState>; id: number }) {
  return (
    <div className="row">
      {[['yes', 'Vote yes'], ['no', 'Vote no']].map(([choice, label]) => (
        <ActionForm key={choice} action={action} submit={label} quiet className="vote">
          <input type="hidden" name="id" value={id} />
          <input type="hidden" name="choice" value={choice} />
        </ActionForm>
      ))}
    </div>
  );
}

export default async function Community() {
  const app = await syncedApp();
  const user = await currentUser();
  const [members, claims, proposals, now, numbers] = await Promise.all([
    memberCount(app),
    listClaims(app),
    listProposals(app),
    chainNow(app.client),
    poolNumbers(app),
  ]);
  const member = user ? await isMember(app, user.wallet) : false;

  const openClaims = await Promise.all(
    claims
      .filter((claim) => !claim.finished)
      .map(async (claim) => ({ claim, voted: user ? await hasVotedOnClaim(app, claim.id, user.wallet) : false })),
  );
  const proposalRows = await Promise.all(
    proposals.map(async (proposal) => ({ proposal, voted: user ? await hasVotedOnProposal(app, proposal.id, user.wallet) : false })),
  );

  return (
    <>
      <AutoRefresh seconds={6} />
      <h1>Community</h1>
      <p className="lead">Members decide what the rules can&apos;t. One member, one vote, however much they hold in the pool.</p>
      <p className="muted small">
        {members} members, including 5 pretend ones who vote by themselves so you can try this alone. They approve anything that
        doesn&apos;t say &quot;fake&quot; or &quot;reject&quot;.
      </p>

      {user && !member ? (
        <section className="section card" style={{ maxWidth: 520 }}>
          <h2>Become a member</h2>
          <p className="small muted">
            A real version would need a proper identity check, so one person can&apos;t have many votes. This one is a stand-in that
            checks nothing. Use made up details. Only a scrambled version is kept.
          </p>
          <ActionForm action={join} submit="Run the fake check">
            <label>Name<input name="fullName" required autoComplete="off" /></label>
            <label>Country<input name="country" required autoComplete="off" /></label>
          </ActionForm>
        </section>
      ) : null}
      {member ? <p className="callout">You&apos;re a member.</p> : null}

      <section className="section">
        <h2>Claims to review</h2>
        {openClaims.length === 0 ? (
          <p className="muted">No open claims.</p>
        ) : (
          <div className="stack">
            {openClaims.map(({ claim, voted }) => {
              const own = user?.wallet.toLowerCase() === claim.holder.toLowerCase();
              return (
                <article key={claim.id} className="card">
                  <h3>{claim.label ?? `Claim ${claim.id}`}</h3>
                  <blockquote style={{ margin: '0 0 10px' }}>{claim.evidence}</blockquote>
                  <p className="small muted">
                    {claim.yes} yes, {claim.no} no, {claim.needed} votes needed.{' '}
                    {claim.endsAt > now ? `Closes in ${duration(claim.endsAt - now)}.` : 'Closing now.'}
                  </p>
                  {member && !voted && !own && claim.endsAt > now ? <VoteButtons action={claimVote} id={claim.id} /> : null}
                  {voted ? <p className="small">You&apos;ve voted.</p> : null}
                  {own ? <p className="small">This is your claim, so you can&apos;t vote on it.</p> : null}
                </article>
              );
            })}
          </div>
        )}
      </section>

      <section className="section">
        <h2>Proposals</h2>
        {proposalRows.length === 0 ? (
          <p className="muted">No proposals yet.</p>
        ) : (
          <div className="stack">
            {proposalRows.map(({ proposal, voted }) => (
              <article key={proposal.id} className="card">
                <p>{proposal.text}</p>
                <p className="small muted">
                  {proposal.yes} yes, {proposal.no} no, {proposal.needed} votes needed.{' '}
                  {proposal.executed
                    ? 'Applied.'
                    : proposal.queued
                      ? 'Passed, waiting out the delay.'
                      : proposal.endsAt > now
                        ? `Closes ${dateTime(proposal.endsAt)}.`
                        : 'Voting closed.'}
                </p>
                {member && !voted && proposal.endsAt > now ? <VoteButtons action={proposalVote} id={proposal.id} /> : null}
                {voted ? <p className="small">You&apos;ve voted.</p> : null}
              </article>
            ))}
          </div>
        )}
      </section>

      {member ? (
        <section className="section card" style={{ maxWidth: 520 }}>
          <h2>Suggest a change</h2>
          <p className="small muted">Members can change only these settings. Passed changes wait 1 day before they apply, so people can react.</p>
          <ActionForm action={propose} submit="Open a vote">
            <label>
              Setting
              <select name="setting">
                {Object.entries(VOTABLE_SETTINGS).map(([key, value]) => <option key={key} value={key}>{value.label}</option>)}
              </select>
            </label>
            <label>New value<input name="value" type="number" min="0" required /></label>
            <label>Why?<input name="note" maxLength={300} /></label>
          </ActionForm>
          <p className="small muted" style={{ marginTop: 12 }}>
            Today: give back {numbers.memberRebateBps} basis points, pool limit {toUsd(numbers.poolCap).toLocaleString('en-GB')} test
            dollars, wait {duration(numbers.withdrawalWait)}.
          </p>
        </section>
      ) : null}
    </>
  );
}
