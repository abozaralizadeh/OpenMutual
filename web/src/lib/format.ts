import { formatUnits } from 'viem';

export function money(units: bigint | string | number): string {
  const value = Number(formatUnits(BigInt(units), 6));
  return `${value.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} tUSD`;
}

export function shortDate(time: number): string {
  return new Date(time * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

export function dateTime(time: number): string {
  return `${new Date(time * 1000).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' })} UTC`;
}

export function clockTime(time: number): string {
  return new Date(time * 1000).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' });
}

export function percent(value: number): string {
  return `${(value * 100).toLocaleString('en-GB', { maximumFractionDigits: 1 })}%`;
}

export function duration(seconds: number): string {
  if (seconds <= 0) return 'now';
  const days = Math.round(seconds / 86_400);
  if (seconds >= 86_400) return `${days} day${days === 1 ? '' : 's'}`;
  const hours = Math.ceil(seconds / 3600);
  return `${hours} hour${hours === 1 ? '' : 's'}`;
}

export const STATUS_WORDS: Record<string, string> = {
  Active: 'Active',
  ClaimOpen: 'Claim being decided',
  PaidOut: 'Paid out',
  Expired: 'Ended, no payout',
  Refunded: 'Price refunded',
};

/** Where a claim is on the ladder, in plain words. */
export const STAGE_WORDS: Record<string, string> = {
  Panel: 'The AI panel is answering',
  Challenge: 'The AI panel agreed. Open for a challenge',
  Jury: 'A jury of members is answering',
  AppealWindow: 'The jury decided. Open for an appeal',
  Appeal: 'An appeal jury is answering',
  Final: 'Decided',
  Done: 'Done',
};

export const ANSWER_WORDS: Record<string, string> = { pay: 'Pay', deny: "Don't pay", unclear: 'Not clear' };

export const OUTCOME_WORDS: Record<string, string> = { Pay: 'Paid', Deny: 'Turned down', NoDecision: 'No decision, price refunded' };
