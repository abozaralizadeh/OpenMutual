import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { projectRoot } from './paths';

export interface ProductConfig {
  key: string;
  name: string;
  kind: 'automatic' | 'reviewed';
  unit: string;
  trigger: number;
  salesCutoffHours: number;
  resultDeadlineDays: number;
  eventLimitBps: number;
  maxPayoutUsd: number;
  payoutUsd: number;
}

export interface Decisions {
  pool: { capUsd: number; starterMoneyUsd: number; withdrawalWaitDays: number; memberRebateBps: number };
  results: { quorum: number; challengeWindowMinutes: number };
  team: { signers: number; required: number; changeDelayHours: number };
  voting: { periodDays: number; quorumBps: number; minVotes: number };
  pricing: {
    mode: 'table' | 'history';
    margin: number;
    riskGroups: Record<RiskGroup, number>;
    historyWeight: number;
  };
  products: ProductConfig[];
}

export type RiskGroup = 'low' | 'middle' | 'high';

export function loadDecisions(): Decisions {
  return JSON.parse(readFileSync(join(projectRoot(), 'config/decisions.json'), 'utf8'));
}

/** Product ids on chain follow the order in decisions.json, starting at 1. */
export function productId(decisions: Decisions, key: string): number {
  const index = decisions.products.findIndex((product) => product.key === key);
  if (index < 0) throw new Error(`Unknown product ${key}`);
  return index + 1;
}

export function productById(decisions: Decisions, id: number): ProductConfig {
  const product = decisions.products[id - 1];
  if (!product) throw new Error(`Unknown product id ${id}`);
  return product;
}
