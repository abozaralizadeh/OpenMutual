import {
  assessorTable,
  chainNow,
  hasVotedOnClaim,
  hasVotedOnProposal,
  isMember,
  juryCount,
  jurySeat,
  ladderOn,
  ladderSettingsNow,
  listClaims,
  listLadderClaims,
  listProposals,
  memberCount,
  myVote,
  PRETEND_JUROR_COUNT,
  poolNumbers,
  toUsd,
  VOTABLE_SETTINGS,
  type App,
  type LadderClaim,
  type User,
} from '@openmutual/shared';
import { ActionForm } from '@/components/ActionForm';
import { AutoRefresh } from '@/components/AutoRefresh';
import { LadderSteps } from '@/components/LadderSteps';
import { appeal, challenge, claimVote, join, joinTheJury, juryAnswer, leaveTheJury, proposalVote, propose, type ActionState } from '@/lib/actions';
import { ANSWER_WORDS, dateTime, duration, money, OUTCOME_WORDS } from '@/lib/format';
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

const IN_ROUND = ['Panel', 'Jury', 'Appeal'];

function seatedNow(claim: LadderClaim, wallet: string) {
  const round = claim.rounds.find((item) => item.round === claim.round);
  return IN_ROUND.includes(claim.stage) && Boolean(round?.seats.some((seat) => seat.toLowerCase() === wallet.toLowerCase()));
}

/** The ladder view: jury duty, claims being decided, the AI assessors and what was decided. */
async function Ladder({ app, user, member, now }: { app: App; user: User | null; member: boolean; now: number }) {
  const [claims, assessors, seat, jurors, settings] = await Promise.all([
    listLadderClaims(app, 30),
    assessorTable(app),
    user && member ? jurySeat(app, user.wallet) : null,
    juryCount(app),
    ladderSettingsNow(app),
  ]);
  const open = claims.filter((claim) => claim.stage !== 'Done');
  const decided = claims.filter((claim) => claim.stage === 'Done').slice(0, 10);
  const duty = user ? open.filter((claim) => seatedNow(claim, user.wallet)).map((claim) => ({ claim, vote: myVote(app, claim.id, claim.round, user.wallet) })) : [];
  const waitingOnMe = new Set(duty.filter(({ vote }) => !vote).map(({ claim }) => claim.id));

  return (
    <>
      {member && seat ? (
        <section className="section card" style={{ maxWidth: 620 }}>
          <h2>Jury duty</h2>
          {seat.active ? (
            <>
              <p className="small">
                You&apos;re in the jury pool. Reputation {seat.reputation}, bond {money(seat.bond)}. When you&apos;re picked, the claim shows up
                here. You&apos;re scored the same for a yes and a no, only on matching the final answer.
              </p>
              <ActionForm action={leaveTheJury} submit="Leave the jury pool" quiet />
            </>
          ) : (
            <>
              <p className="small">
                Juries are picked at random from members who put up a {money(settings.jurorBond)} bond. You get it back when you leave.
                Miss a claim you were picked for and you lose a little of it.
              </p>
              <ActionForm action={joinTheJury} submit="Join the jury pool" />
            </>
          )}
          {duty.map(({ claim, vote }) => (
            <article key={claim.id} className="card" style={{ marginTop: 14 }} data-testid="jury-duty">
              <h3>{claim.label ?? `Claim ${claim.id}`}</h3>
              <blockquote style={{ margin: '0 0 10px' }}>{claim.evidence}</blockquote>
              {vote ? (
                <p className="small">You answered: {ANSWER_WORDS[vote.verdict]}. It stays sealed until everyone has answered.</p>
              ) : (
                <ActionForm action={juryAnswer} submit="Seal my answer">
                  <input type="hidden" name="id" value={claim.id} />
                  <fieldset className="row" style={{ border: 0, padding: 0, margin: 0 }}>
                    <legend className="small" style={{ marginBottom: 6 }}>Does the cover pay for this?</legend>
                    {(['pay', 'deny', 'unclear'] as const).map((choice) => (
                      <label key={choice} className="row" style={{ gap: 6 }}>
                        <input type="radio" name="choice" value={choice} required /> {ANSWER_WORDS[choice]}
                      </label>
                    ))}
                  </fieldset>
                  <label>Why? (optional)<input name="why" maxLength={300} /></label>
                  <p className="small muted" style={{ margin: 0 }}>If it could go either way, the claimant gets the benefit of the doubt.</p>
                </ActionForm>
              )}
            </article>
          ))}
        </section>
      ) : null}

      <section className="section">
        <h2>Claims being decided</h2>
        {open.length === 0 ? (
          <p className="muted">No open claims.</p>
        ) : (
          <div className="stack">
            {open.map((claim) => {
              const own = user?.wallet.toLowerCase() === claim.holder.toLowerCase();
              // Someone still answering doesn't get to see the other answers first.
              const hidden = waitingOnMe.has(claim.id) ? claim.rounds.map((round) => round.round) : [];
              return (
                <article key={claim.id} className="card" data-testid={`claim-${claim.id}`}>
                  <h3>{claim.label ?? `Claim ${claim.id}`}</h3>
                  <blockquote style={{ margin: '0 0 10px' }}>{claim.evidence}</blockquote>
                  <LadderSteps claim={claim} now={now} hideRounds={hidden} />
                  {member && !own && claim.stage === 'Challenge' && claim.windowEnds > now ? (
                    <ActionForm action={challenge} submit={`Challenge for ${money(settings.challengeBond)}`} quiet>
                      <input type="hidden" name="id" value={claim.id} />
                      <p className="small muted" style={{ margin: 0 }}>Think the panel got it wrong? A jury decides. Your bond comes back if it changes the answer.</p>
                    </ActionForm>
                  ) : null}
                  {member && !own && claim.stage === 'AppealWindow' && claim.windowEnds > now ? (
                    <ActionForm action={appeal} submit={`Appeal for ${money(settings.appealBond)}`} quiet>
                      <input type="hidden" name="id" value={claim.id} />
                    </ActionForm>
                  ) : null}
                  {own ? <p className="small">This is your claim. You can&apos;t sit on it.</p> : null}
                </article>
              );
            })}
          </div>
        )}
      </section>

      <section className="section card">
        <h2>AI assessors</h2>
        <p className="small muted">
          Local fakes with known habits, standing in for real AI models. Each one answers alone and in secret. A claim only settles at
          this step if every one of them agrees and is at least {settings.minConfidence}% sure. Hidden test claims with known answers
          check them, and a wrong answer on a test costs reputation and part of the bond. They stop being picked below 50, or once more than 1 in 4 of their tests are wrong.
        </p>
        <div className="table-wrap">
          <table className="compact">
            <thead>
              <tr><th>Assessor</th><th>Maker</th><th className="num">Reputation</th><th className="num">Tests passed</th><th className="num">Tests failed</th><th className="num">Bond</th><th>Status</th></tr>
            </thead>
            <tbody>
              {assessors.map((row) => (
                <tr key={row.address}>
                  <td>{row.name}</td>
                  <td>{row.maker}</td>
                  <td className="num">{row.reputation}</td>
                  <td className="num">{row.testsPassed}</td>
                  <td className="num">{row.testsFailed}</td>
                  <td className="num">{money(row.bond)}</td>
                  <td>{row.eligible ? 'Picked at random' : 'Benched'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="small muted" style={{ marginBottom: 0 }}>{jurors} people can be picked for a jury right now.</p>
      </section>

      <section className="section">
        <h2>Decided claims</h2>
        <p className="small muted">Every answer and every reason stays public, so the next claim can be judged the same way.</p>
        {decided.length === 0 ? (
          <p className="muted">Nothing decided yet.</p>
        ) : (
          <div className="stack">
            {decided.map((claim) => (
              <article key={claim.id} className="card">
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <h3 style={{ margin: 0 }}>{claim.label ?? `Claim ${claim.id}`}</h3>
                  <span className="tag">{claim.test ? 'Hidden test' : OUTCOME_WORDS[claim.outcome]}</span>
                </div>
                <blockquote style={{ margin: '10px 0' }}>{claim.evidence}</blockquote>
                <LadderSteps claim={claim} now={now} />
              </article>
            ))}
          </div>
        )}
      </section>
    </>
  );
}

export default async function Community() {
  const app = await syncedApp();
  const user = await currentUser();
  const ladder = ladderOn(app);
  const [members, claims, proposals, now, numbers] = await Promise.all([
    memberCount(app),
    ladder ? [] : listClaims(app),
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
      <p className="lead">
        Members decide what the rules can&apos;t. One member, one vote, however much they hold in the pool.
        {ladder ? ' Claims that need judgement climb a ladder: an AI panel first, then a random jury of members, then one appeal.' : null}
      </p>
      {ladder ? (
        <p className="muted small">
          {members} members. So you can try this alone, 5 pretend ones vote on proposals and {PRETEND_JUROR_COUNT} pretend ones sit on
          juries. Proposals pass unless they say &quot;reject&quot;. Pretend jurors read claims the way a person would and get about 1 in 20
          wrong.
        </p>
      ) : (
        <p className="muted small">
          {members} members, including 5 pretend ones who vote by themselves so you can try this alone. They approve anything that
          doesn&apos;t say &quot;fake&quot; or &quot;reject&quot;.
        </p>
      )}

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

      {ladder ? <Ladder app={app} user={user} member={member} now={now} /> : null}

      {ladder ? null : <section className="section">
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
      </section>}

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
