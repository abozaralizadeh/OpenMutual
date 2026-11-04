import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export const CONTRACT_NAMES = [
  'TestUSD',
  'MutualPool',
  'ResultOracle',
  'CoverBook',
  'Membership',
  'ClaimReview',
  'ClaimLadder',
  'MemberGovernor',
  'TeamMultisig',
  'TimelockController',
] as const;

export type ContractName = (typeof CONTRACT_NAMES)[number];

/** Finds the project folder from wherever a process was started. */
export function projectRoot(): string {
  if (process.env.OPENMUTUAL_HOME) return resolve(process.env.OPENMUTUAL_HOME);
  let dir = process.cwd();
  while (!existsSync(join(dir, 'config/decisions.json'))) {
    const parent = dirname(dir);
    if (parent === dir) throw new Error('Could not find the project folder (no config/decisions.json above here)');
    dir = parent;
  }
  return dir;
}

export function dataDir(): string {
  const dir = process.env.DATA_DIR ? resolve(process.env.DATA_DIR) : join(projectRoot(), 'data');
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function logDir(): string {
  const dir = process.env.LOG_DIR ? resolve(process.env.LOG_DIR) : join(projectRoot(), 'logs');
  mkdirSync(dir, { recursive: true });
  return dir;
}
