/** A cancelled flight is reported as this value, which beats any delay threshold. */
export const CANCELLED = 0xffffffff;

export interface EventQuery {
  kind: 'flight' | 'rain';
  /** Flight number, or city for rain. */
  subject: string;
  /** YYYY-MM-DD */
  date: string;
}

/**
 * Where results come from. The real thing would be a paid flight or weather API,
 * which this project doesn't call. Today only the local fakes implement this.
 */
export interface ResultSource {
  name: string;
  /** The measured value, or null if it isn't known yet. Throws if the source is down. */
  read(query: EventQuery, now: number): Promise<number | null>;
}

/** Lets a demo force a result. The fake sources check this first. */
export type DemoResults = (query: EventQuery) => number | null;
