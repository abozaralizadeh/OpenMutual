// Deploys a fresh set of contracts to the local chain and clears the local database.
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { assertLocalChain, publicClient } from './chain';
import { deployAll, saveDeployment } from './deploy';
import { dataDir } from './paths';

const client = publicClient();
await assertLocalChain(client);
const addresses = await deployAll(client);
saveDeployment(addresses);
for (const suffix of ['', '-wal', '-shm']) {
  rmSync(join(dataDir(), `openmutual.sqlite${suffix}`), { force: true });
}
console.log('Deployed to the local chain:');
console.log(addresses);
