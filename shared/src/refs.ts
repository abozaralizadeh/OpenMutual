import { keccak256, toBytes, type Hex } from 'viem';
import { CANCELLED, type EventQuery } from './sources/types';

export function refFor(text: string): Hex {
  return keccak256(toBytes(text));
}

export function flightRef(number: string, date: string): Hex {
  return refFor(`flight:${number}:${date}`);
}

export function rainRef(city: string, date: string): Hex {
  return refFor(`rain:${city}:${date}`);
}

export function describeValue(productKey: string, value: number): string {
  if (productKey === 'flight-delay') {
    return value === CANCELLED ? 'cancelled' : `${value} minutes late`;
  }
  return `${value} mm of rain`;
}

export function queryFromDetails(details: { kind: string; subject: string; date: string }): EventQuery | null {
  if (details.kind === 'flight' || details.kind === 'rain') {
    return { kind: details.kind, subject: details.subject, date: details.date };
  }
  return null;
}
