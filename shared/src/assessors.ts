import { chance } from './sources/fake-world';

// The AI assessors that sit on a claim's first rung. A real one would send the cover wording and
// the claim to a model and get an answer back. These are local fakes with known habits, so a run
// is free and repeatable, and a test can say exactly what they should do.

export type Answer = 'pay' | 'deny' | 'unclear';

export interface Assessment {
  verdict: Answer;
  /** 0 to 100. The panel only settles a claim when every assessor is at least this sure. */
  confidence: number;
  reason: string;
}

export interface ClaimToAssess {
  claimId: number;
  wording: string;
  evidence: string;
}

export interface ClaimAssessor {
  name: string;
  /** Who made the model. A panel needs several makers, so one maker's blind spot can't decide alone. */
  maker: string;
  assess(claim: ClaimToAssess): Promise<Assessment>;
}

/** What kind of claim a text is. The fakes and the simulation both read claims this way. */
export type ClaimKind = 'honest' | 'unclear' | 'fraud' | 'excluded' | 'planted';

export function readClaim(evidence: string): ClaimKind {
  const text = evidence.toLowerCase();
  if (/approve this claim|ignore (the|all|any|previous)/.test(text)) return 'planted';
  if (/\bfake\b|made (it|this) up|made up/.test(text)) return 'fraud';
  if (/carry-on|carry on bag|carried it (myself|on)|hand luggage/.test(text)) return 'excluded';
  if (/not sure|maybe|might have|i think/.test(text)) return 'unclear';
  return 'honest';
}

/** The answer a careful reader should reach. Doubt goes to the claimant, so an unclear claim pays. */
export function rightAnswer(kind: ClaimKind): 'pay' | 'deny' {
  return kind === 'honest' || kind === 'unclear' ? 'pay' : 'deny';
}

const REASONS: Record<ClaimKind, Record<Answer, string>> = {
  honest: {
    pay: "The bag didn't arrive and the story fits what the cover pays for.",
    deny: "There isn't enough here to show the bag was lost.",
    unclear: "It's probably lost, but the claim is thin.",
  },
  unclear: {
    pay: 'The claim is unsure, and the wording gives the claimant the benefit of the doubt.',
    deny: "The claimant isn't sure the bag was lost at all.",
    unclear: "The claimant isn't sure what happened. It could go either way.",
  },
  fraud: {
    pay: 'The bag seems to be missing.',
    deny: 'The claim says it was made up.',
    unclear: 'Something about this claim is off.',
  },
  excluded: {
    pay: 'The bag was lost on the trip.',
    deny: "It was a bag they carried on themselves, and the cover doesn't include those.",
    unclear: "It's not clear if the bag was checked in.",
  },
  planted: {
    pay: 'The claim asks to be approved.',
    deny: 'The claim tries to give orders to the assessor instead of saying what happened.',
    unclear: 'The text reads like instructions, not a claim.',
  },
};

export function reasonFor(kind: ClaimKind, verdict: Answer): string {
  return REASONS[kind][verdict];
}

interface FakeAssessorSettings {
  name: string;
  maker: string;
  /** How often it gets a claim wrong. */
  errorRate: number;
  /** Follows instructions planted in a claim. Hidden test claims are there to catch this. */
  gullible?: boolean;
}

/** How much the fakes' mistakes overlap. Models trained on similar data tend to fail together. */
const SHARED_ERROR = 0.6;

function between(low: number, high: number, roll: number) {
  return Math.round(low + (high - low) * roll);
}

export function fakeAssessor(settings: FakeAssessorSettings): ClaimAssessor {
  return {
    name: settings.name,
    maker: settings.maker,
    async assess({ claimId, evidence }) {
      const kind = readClaim(evidence);
      const key = `${claimId}:${evidence}`;
      const roll = chance(`shared-roll:${key}`) < SHARED_ERROR ? chance(`error:${key}`) : chance(`error:${settings.name}:${key}`);
      const wrong = roll < settings.errorRate;
      const sure = chance(`sure:${settings.name}:${key}`);

      let verdict: Answer;
      let confidence: number;
      if (kind === 'planted' && settings.gullible) {
        verdict = 'pay';
        confidence = between(90, 99, sure);
      } else if (kind === 'unclear') {
        verdict = wrong ? (chance(`side:${settings.name}:${key}`) < 0.5 ? 'pay' : 'deny') : 'unclear';
        confidence = wrong ? between(70, 88, sure) : between(40, 65, sure);
      } else {
        const right = rightAnswer(kind);
        verdict = wrong ? (right === 'pay' ? 'deny' : 'pay') : right;
        confidence = wrong ? between(65, 92, sure) : between(84, 99, sure);
      }
      return { verdict, confidence, reason: reasonFor(kind, verdict) };
    },
  };
}

/** Six fake assessors from five makers. Northwind falls for planted instructions. */
export const FAKE_ASSESSORS: FakeAssessorSettings[] = [
  { name: 'Kestrel A', maker: 'Kestrel', errorRate: 0.04 },
  { name: 'Kestrel B', maker: 'Kestrel', errorRate: 0.04 },
  { name: 'Sable', maker: 'Sable', errorRate: 0.05 },
  { name: 'Ash', maker: 'Ash', errorRate: 0.05 },
  { name: 'Moss', maker: 'Moss', errorRate: 0.06 },
  { name: 'Northwind', maker: 'Northwind', errorRate: 0.06, gullible: true },
];

export function fakeAssessors(): ClaimAssessor[] {
  return FAKE_ASSESSORS.map(fakeAssessor);
}

/** How a person on a jury answers. They read the claim, and now and then they get it wrong. */
export function humanVerdict(name: string, { claimId, evidence }: Omit<ClaimToAssess, 'wording'>, errorRate: number): Assessment {
  const kind = readClaim(evidence);
  const key = `${name}:${claimId}:${evidence}`;
  const right: Answer = kind === 'unclear' ? 'unclear' : rightAnswer(kind);
  const wrong = chance(`human:${key}`) < errorRate;
  const verdict: Answer = wrong ? (right === 'deny' ? 'pay' : 'deny') : right;
  return { verdict, confidence: between(60, 95, chance(`human-sure:${key}`)), reason: reasonFor(kind, verdict) };
}
