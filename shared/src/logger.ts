import { appendFileSync, existsSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { logDir } from './paths';

const MAX_BYTES = 5 * 1024 * 1024;
const KEEP_FILES = 2;

/** Writes to stdout (so journalctl sees it) and to a rotating file capped at 15 MB in all. */
export function createLogger(name: string) {
  const file = join(logDir(), `${name}.log`);

  function rotate() {
    if (!existsSync(file) || statSync(file).size < MAX_BYTES) return;
    rmSync(`${file}.${KEEP_FILES}`, { force: true });
    for (let i = KEEP_FILES - 1; i >= 1; i--) {
      if (existsSync(`${file}.${i}`)) renameSync(`${file}.${i}`, `${file}.${i + 1}`);
    }
    renameSync(file, `${file}.1`);
  }

  function write(level: string, message: string, extra?: unknown) {
    const detail = extra === undefined ? '' : ` ${extra instanceof Error ? extra.message : JSON.stringify(extra)}`;
    const line = `${new Date().toISOString()} ${level} ${message}${detail}`;
    console.log(line);
    try {
      rotate();
      appendFileSync(file, `${line}\n`);
    } catch (error) {
      console.error('Could not write log file', error);
    }
  }

  return {
    info: (message: string, extra?: unknown) => write('INFO', message, extra),
    warn: (message: string, extra?: unknown) => write('WARN', message, extra),
    error: (message: string, extra?: unknown) => write('ERROR', message, extra),
  };
}

export type Logger = ReturnType<typeof createLogger>;
