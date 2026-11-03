import type { Decisions, RiskGroup } from './config';
import { usdToUnits } from './deploy';
import { routeHistory, routeRisk } from './sources/fake-world';

export interface PriceInput {
  productKey: string;
  payout: bigint;
  /** Flights only. */
  route?: { from: string; to: string; date: string };
}

export interface Price {
  chance: number;
  premium: bigint;
}

/** How a price is made. Swap the engine in config/decisions.json. */
export interface PricingEngine {
  name: string;
  price(input: PriceInput): Price;
}

export const NON_FLIGHT_CHANCE: Record<string, number> = { 'rainy-day': 0.12, 'lost-bag': 0.02 };

function premiumFor(chance: number, payout: bigint, margin: number): bigint {
  const raw = Number(payout) * chance * (1 + margin);
  // Round up to a whole cent, and keep the premium under the payout.
  const cents = Math.ceil(raw / 10_000) * 10_000;
  const premium = BigInt(cents);
  return premium < payout ? premium : payout - usdToUnits(0.01);
}

function baseChance(decisions: Decisions, input: PriceInput): number {
  if (input.route) {
    const group: RiskGroup = routeRisk(input.route.from, input.route.to);
    return decisions.pricing.riskGroups[group];
  }
  return NON_FLIGHT_CHANCE[input.productKey] ?? 0.1;
}

/** Fixed table: each route falls in a low, middle or high group. */
export function tablePricing(decisions: Decisions): PricingEngine {
  return {
    name: 'table',
    price(input) {
      const chance = baseChance(decisions, input);
      return { chance, premium: premiumFor(chance, input.payout, decisions.pricing.margin) };
    },
  };
}

/**
 * Starts from the table and moves towards what actually happened on the route.
 * historyWeight is how many flights the table counts for, so a route with little
 * history stays close to the table.
 */
export function historyPricing(decisions: Decisions, history = routeHistory): PricingEngine {
  return {
    name: 'history',
    price(input) {
      const prior = baseChance(decisions, input);
      if (!input.route) return { chance: prior, premium: premiumFor(prior, input.payout, decisions.pricing.margin) };
      const { flights, late } = history(input.route.from, input.route.to, input.route.date);
      const weight = decisions.pricing.historyWeight;
      const chance = (prior * weight + late) / (weight + flights);
      return { chance, premium: premiumFor(chance, input.payout, decisions.pricing.margin) };
    },
  };
}

export function pricingEngine(decisions: Decisions): PricingEngine {
  return decisions.pricing.mode === 'history' ? historyPricing(decisions) : tablePricing(decisions);
}
