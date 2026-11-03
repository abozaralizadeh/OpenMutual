import { CANCELLED, type DemoResults, type EventQuery, type ResultSource } from './types';
import { dayStart, findFlight, flightOutcome, rainfall } from './fake-world';

const HOUR = 3600;

export interface FakeOptions {
  name: string;
  /** Moves delays by a few minutes, as real sources disagree a little. */
  noise?: number;
  demo?: DemoResults;
}

/** Local stand in for a paid flight data and weather API. */
export function fakeSource({ name, noise = 0, demo }: FakeOptions): ResultSource {
  return {
    name,
    async read(query: EventQuery, now: number) {
      const forced = demo?.(query);
      if (query.kind === 'rain') {
        if (now < dayStart(query.date) + 24 * HOUR) return null;
        return forced ?? rainfall(query.subject, query.date);
      }

      const flight = findFlight(query.subject, query.date);
      if (!flight) return null;
      if (forced !== null && forced !== undefined) {
        return now >= flight.departure ? forced : null;
      }
      const outcome = flightOutcome(flight);
      if (outcome.cancelled) return now >= flight.departure - 12 * HOUR ? CANCELLED : null;
      if (now < flight.arrival + outcome.delayMinutes * 60) return null;
      return Math.max(0, outcome.delayMinutes + noise);
    },
  };
}

export function fakeSources(demo?: DemoResults): ResultSource[] {
  return [fakeSource({ name: 'fake-a', noise: 0, demo }), fakeSource({ name: 'fake-b', noise: 2, demo }), fakeSource({ name: 'fake-c', noise: -3, demo })];
}
