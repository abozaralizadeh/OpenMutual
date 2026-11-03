import { spawn, type ChildProcess } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { projectRoot } from '@openmutual/shared';

function anvilBinary(): string {
  const base = join(projectRoot(), 'node_modules/@foundry-rs');
  const folder = readdirSync(base).find((name) => name.startsWith('anvil-'));
  if (!folder) throw new Error('Anvil is not installed. Run npm install.');
  return join(base, folder, 'bin/anvil');
}

/** Starts a throwaway local chain on its own port. Only ever on this machine. */
export async function launchChain(port: number): Promise<{ child: ChildProcess; url: string }> {
  const child = spawn(anvilBinary(), ['--port', String(port), '--host', '127.0.0.1', '--chain-id', '31337', '--silent'], { stdio: 'ignore' });
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try {
      await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }) });
      return { child, url };
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  child.kill('SIGKILL');
  throw new Error('Local chain did not start');
}
