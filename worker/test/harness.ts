import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp, createLogger, deployAll, openDb, publicClient, type App, type Logger } from '@openmutual/shared';
import type { PublicClient } from 'viem';
import { launchChain } from '../src/local-chain';

export interface Harness {
  app: App;
  log: Logger;
  stop: () => void;
  dir: string;
}

/** A fresh chain and database for one test file. */
export async function startHarness(): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'openmutual-test-'));
  process.env.LOG_DIR = dir;
  process.env.DATA_DIR = dir;
  const { child, url } = await launchChain(20_000 + Math.floor(Math.random() * 30_000));
  process.env.RPC_URL = url;
  const client = publicClient(url) as PublicClient;
  const addresses = await deployAll(client);
  const app = createApp({ client, addresses, db: openDb(join(dir, 'test.sqlite')) });
  const log = createLogger('test');
  if (!process.env.TEST_LOGS) {
    log.info = () => {};
    log.warn = () => {};
  }
  return {
    app,
    log,
    dir,
    stop: () => {
      child.kill('SIGKILL');
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
