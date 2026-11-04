import { assertLocalChain, createApp, createLogger, fakeSources } from '@openmutual/shared';
import { seedSimulatedMembers } from './seed';
import { demoResults, tick } from './tick';

const INTERVAL_MS = Number(process.env.WORKER_INTERVAL_MS ?? 3000);
const log = createLogger('worker');

const app = createApp();
await assertLocalChain(app.client);
const simulated = process.env.SIMULATED_MEMBERS !== 'false';
await seedSimulatedMembers(app, { pretendJurors: simulated });
const sources = fakeSources(demoResults(app));
log.info('Worker started', { sources: sources.map((source) => source.name), pricing: app.pricing.name });

let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    stopping = true;
  });
}

while (!stopping) {
  await tick(app, sources, log, { simulatedMembers: simulated });
  await new Promise((resolve) => setTimeout(resolve, INTERVAL_MS));
}
log.info('Worker stopped');
