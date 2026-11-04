import type { LadderClaim, LadderRound } from '@openmutual/shared';
import { ANSWER_WORDS, duration, OUTCOME_WORDS, STAGE_WORDS } from '@/lib/format';

const ROUND_NAMES = ['AI panel', 'Jury', 'Appeal jury'];

function timeLeft(claim: LadderClaim, now: number): string | null {
  const round = claim.rounds.find((item) => item.round === claim.round);
  if (['Panel', 'Jury', 'Appeal'].includes(claim.stage) && round) {
    if (round.committed < round.seats.length && round.commitEnds > now) return `${round.committed} of ${round.seats.length} have answered. Time left: ${duration(round.commitEnds - now)}.`;
    return 'Opening the answers.';
  }
  if (claim.stage === 'Challenge' || claim.stage === 'AppealWindow') return claim.windowEnds > now ? `Closes in ${duration(claim.windowEnds - now)}.` : 'Closing now.';
  return null;
}

function Round({ round, hidden }: { round: LadderRound; hidden: boolean }) {
  const name = ROUND_NAMES[round.round];
  if (hidden) return <p className="small muted">{name}: answers stay hidden until you&apos;ve answered.</p>;
  if (round.revealed === 0) return <p className="small muted">{name}: {round.seats.length} picked, answers still sealed.</p>;
  if (round.round > 0) {
    return (
      <p className="small">
        {name} of {round.seats.length}: {round.pay} pay, {round.deny} don&apos;t pay, {round.unclear} not clear.
      </p>
    );
  }
  return (
    <div className="small">
      <p style={{ margin: '0 0 4px' }}>{name}:</p>
      <ul className="steps" data-testid="panel-answers">
        {round.answers.map((answer) => (
          <li key={answer.who}>
            <strong>{answer.name}</strong>: {ANSWER_WORDS[answer.verdict]}, {answer.confidence}% sure. {answer.reason}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Where a claim is on the ladder and what each rung said. */
export function LadderSteps({ claim, now, hideRounds = [] }: { claim: LadderClaim; now: number; hideRounds?: number[] }) {
  const left = timeLeft(claim, now);
  return (
    <div className="stack" style={{ gap: 6 }}>
      <p className="small" style={{ margin: 0 }} data-testid="ladder-stage">
        <strong>{claim.stage === 'Done' ? (claim.test ? 'Hidden test claim. Price refunded' : OUTCOME_WORDS[claim.outcome]) : STAGE_WORDS[claim.stage]}</strong>
        {claim.stage === 'Final' ? `: ${OUTCOME_WORDS[claim.outcome].toLowerCase()}. It settles within the hour` : null}
        {left ? `. ${left}` : null}
      </p>
      {claim.rounds.map((round) => <Round key={round.round} round={round} hidden={hideRounds.includes(round.round)} />)}
      {claim.rounds.length > 0 && claim.rounds[0].round > 0 ? <p className="small muted">Not enough different AI makers were free, so people decide this one.</p> : null}
      {claim.rounds.length === 0 && claim.outcome === 'NoDecision' ? <p className="small muted">Not enough judges were free to decide it.</p> : null}
    </div>
  );
}
