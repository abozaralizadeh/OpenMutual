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
  ClaimOpen: 'Members are voting',
  PaidOut: 'Paid out',
  Expired: 'Ended, no payout',
  Refunded: 'Price refunded',
};
