import { keccak256, toBytes } from 'viem';
import type { RiskGroup } from '../config';

// A made up world of flights and weather. It's all generated from a hash, so the
// same flight always has the same outcome, and every run is repeatable.

const AIRPORTS = ['FCO', 'MXP', 'LHR', 'CDG', 'FRA', 'MAD', 'AMS', 'BCN', 'ATH', 'LIS', 'DUB', 'VIE'];
const CITIES = ['Rome', 'Milan', 'London', 'Paris', 'Madrid', 'Athens'];
const FLIGHTS_PER_DAY = 24;
const HOUR = 3600;

/** Chance of a delay of 3 hours or more, or a cancellation. Set from public statistics: about 3% of US flights, 1.5 to 2% in the UK and Europe. */
const LATE_CHANCE: Record<RiskGroup, number> = { low: 0.01, middle: 0.025, high: 0.05 };
const STORM_CHANCE = 0.02;
const STORM_LATE_CHANCE = 0.2;
const CANCELLED_SHARE = 0.4;

/** A number from 0 to 1 that depends only on the text. */
export function chance(text: string): number {
  const hash = keccak256(toBytes(text));
  return Number(BigInt(hash.slice(0, 14))) / 2 ** 48;
}

function pick<T>(list: T[], text: string): T {
  return list[Math.floor(chance(text) * list.length)];
}

export interface Flight {
  number: string;
  from: string;
  to: string;
  date: string;
  departure: number;
  arrival: number;
  risk: RiskGroup;
}

export function dayStart(date: string): number {
  return Date.parse(`${date}T00:00:00Z`) / 1000;
}

export function dateOf(time: number): string {
  return new Date(time * 1000).toISOString().slice(0, 10);
}

export function routeRisk(from: string, to: string): RiskGroup {
  const value = chance(`risk:${from}:${to}`);
  if (value < 0.4) return 'low';
  return value < 0.85 ? 'middle' : 'high';
}

export function flightsOn(date: string): Flight[] {
  return Array.from({ length: FLIGHTS_PER_DAY }, (_, index) => {
    const number = `TA${100 + index}`;
    const from = pick(AIRPORTS, `from:${number}`);
    const to = pick(AIRPORTS.filter((code) => code !== from), `to:${number}`);
    const departure = dayStart(date) + (5 + Math.floor(chance(`dep:${number}`) * 16)) * HOUR;
    const arrival = departure + (2 + Math.floor(chance(`len:${number}`) * 3)) * HOUR;
    return { number, from, to, date, departure, arrival, risk: routeRisk(from, to) };
  });
}

export function findFlight(number: string, date: string): Flight | undefined {
  return flightsOn(date).find((flight) => flight.number === number);
}

export function isStorm(airport: string, date: string): boolean {
  return chance(`storm:${airport}:${date}`) < STORM_CHANCE;
}

export interface FlightOutcome {
  cancelled: boolean;
  delayMinutes: number;
}

export function flightOutcome(flight: Flight): FlightOutcome {
  const seed = `${flight.number}:${flight.date}`;
  const lateChance = isStorm(flight.from, flight.date) ? STORM_LATE_CHANCE : LATE_CHANCE[flight.risk];
  const late = chance(`late:${seed}`) < lateChance;
  if (!late) return { cancelled: false, delayMinutes: Math.floor(chance(`small:${seed}`) * 90) };
  if (chance(`cancel:${seed}`) < CANCELLED_SHARE) return { cancelled: true, delayMinutes: 0 };
  return { cancelled: false, delayMinutes: 180 + Math.floor(chance(`big:${seed}`) * 240) };
}

export function citiesList(): string[] {
  return CITIES;
}

/** Chance of any rain on a day. Two thirds of rainy days reach 10 mm, so that's about 12%, the rate rainy day cover is priced at. */
const RAIN_CHANCE = 0.18;

export function rainfall(city: string, date: string): number {
  if (chance(`rain:${city}:${date}`) >= RAIN_CHANCE) return 0;
  return Math.floor(chance(`amount:${city}:${date}`) * 30);
}

export interface RouteHistory {
  flights: number;
  late: number;
}

/** What a paid data source would give for past flights on a route. */
export function routeHistory(from: string, to: string, beforeDate: string, days = 120): RouteHistory {
  const history: RouteHistory = { flights: 0, late: 0 };
  const end = dayStart(beforeDate);
  for (let i = 1; i <= days; i++) {
    const date = dateOf(end - i * 86_400);
    for (const flight of flightsOn(date)) {
      if (flight.from !== from || flight.to !== to) continue;
      const outcome = flightOutcome(flight);
      history.flights++;
      if (outcome.cancelled || outcome.delayMinutes >= 180) history.late++;
    }
  }
  return history;
}
