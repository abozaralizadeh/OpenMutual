import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { dataDir } from './paths';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  email_hash TEXT NOT NULL UNIQUE,
  wallet TEXT NOT NULL UNIQUE,
  wallet_key TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS login_codes (
  email_hash TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  tries INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS identity_checks (
  person_hash TEXT PRIMARY KEY,
  wallet TEXT NOT NULL UNIQUE,
  checked_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS chain_events (
  tx TEXT NOT NULL,
  log_index INTEGER NOT NULL,
  block INTEGER NOT NULL,
  time INTEGER NOT NULL,
  contract TEXT NOT NULL,
  name TEXT NOT NULL,
  args TEXT NOT NULL,
  PRIMARY KEY (tx, log_index)
);
CREATE INDEX IF NOT EXISTS chain_events_name ON chain_events(name, block);
CREATE TABLE IF NOT EXISTS covers (
  id INTEGER PRIMARY KEY,
  holder TEXT NOT NULL,
  product_id INTEGER NOT NULL,
  event_key TEXT NOT NULL,
  ref TEXT NOT NULL,
  event_time INTEGER NOT NULL,
  premium TEXT NOT NULL,
  payout TEXT NOT NULL,
  status TEXT NOT NULL,
  paid TEXT NOT NULL DEFAULT '0',
  sold_at INTEGER NOT NULL,
  ended_at INTEGER
);
CREATE INDEX IF NOT EXISTS covers_holder ON covers(holder);
CREATE INDEX IF NOT EXISTS covers_status ON covers(status);
CREATE TABLE IF NOT EXISTS labels (
  ref TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  label TEXT NOT NULL,
  details TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS claim_evidence (
  evidence_hash TEXT PRIMARY KEY,
  text TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ladder_votes (
  claim_id INTEGER NOT NULL,
  round INTEGER NOT NULL,
  wallet TEXT NOT NULL,
  verdict INTEGER NOT NULL,
  confidence INTEGER NOT NULL,
  reason_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'sealed',
  PRIMARY KEY (claim_id, round, wallet)
);
CREATE TABLE IF NOT EXISTS claim_notes (
  hash TEXT PRIMARY KEY,
  text TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS test_claims (
  cover_id INTEGER PRIMARY KEY,
  claim_id INTEGER,
  wallet TEXT NOT NULL,
  wallet_key TEXT NOT NULL,
  expected INTEGER NOT NULL,
  salt TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'filed'
);
CREATE TABLE IF NOT EXISTS proposal_notes (
  description_hash TEXT PRIMARY KEY,
  text TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS share_prices (
  time INTEGER PRIMARY KEY,
  price REAL NOT NULL,
  total_assets TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS demo_results (
  ref TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS feedback (
  id INTEGER PRIMARY KEY,
  created_at INTEGER NOT NULL,
  rating INTEGER,
  text TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS usage_counts (
  day TEXT NOT NULL,
  name TEXT NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (day, name)
);
CREATE TABLE IF NOT EXISTS worker_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

export type Db = DatabaseSync;

export function openDb(path = join(dataDir(), 'openmutual.sqlite')): Db {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  return db;
}

export function getState(db: Db, key: string): string | undefined {
  const row = db.prepare('SELECT value FROM worker_state WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value;
}

export function setState(db: Db, key: string, value: string) {
  db.prepare('INSERT INTO worker_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}

/** Counts how often something happens. No user ids, just daily totals. */
export function countUse(db: Db, name: string) {
  const day = new Date().toISOString().slice(0, 10);
  db.prepare(
    'INSERT INTO usage_counts (day, name, count) VALUES (?, ?, 1) ON CONFLICT(day, name) DO UPDATE SET count = count + 1',
  ).run(day, name);
}
