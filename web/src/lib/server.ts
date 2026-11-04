import { randomBytes } from 'node:crypto';
import { cookies } from 'next/headers';
import { createApp, createLogger, hashSecret, loadDeployment, syncEvents, type App, type User } from '@openmutual/shared';
import { COOKIE_PATH } from './base';

const SESSION_COOKIE = 'om_session';
const ADMIN_COOKIE = 'om_admin';
const SESSION_DAYS = 7;

const store = globalThis as unknown as { omApp?: App };

/** stdout for journalctl, plus logs/web.log capped at 15 MB. */
export const log = createLogger('web');

/** One shared app per server process. A fresh local deployment replaces it. */
export function getApp(): App {
  const deployment = loadDeployment();
  if (!store.omApp || store.omApp.addresses.pool !== deployment.pool) {
    store.omApp?.db.close();
    store.omApp = createApp();
    log.info(`Using the deployment with pool ${deployment.pool}`);
  }
  return store.omApp;
}

/** The app, with the database caught up with the chain. */
export async function syncedApp(): Promise<App> {
  const app = getApp();
  await syncEvents(app.db, app.client, app.addresses);
  return app;
}

export async function currentUser(): Promise<User | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const app = getApp();
  const row = app.db
    .prepare(
      `SELECT users.id, users.wallet, users.wallet_key FROM sessions
       JOIN users ON users.id = sessions.user_id
       WHERE sessions.token_hash = ? AND sessions.expires_at > ?`,
    )
    .get(hashSecret(token), Math.floor(Date.now() / 1000)) as User | undefined;
  return row ?? null;
}

export async function startSession(userId: number) {
  const token = randomBytes(32).toString('hex');
  const expires = Math.floor(Date.now() / 1000) + SESSION_DAYS * 86_400;
  getApp().db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(hashSecret(token), userId, expires);
  (await cookies()).set(SESSION_COOKIE, token, { httpOnly: true, sameSite: 'lax', path: COOKIE_PATH, maxAge: SESSION_DAYS * 86_400 });
}

export async function endSession() {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) getApp().db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashSecret(token));
  // Delete it on the same path it was set on, or the browser keeps it.
  jar.set(SESSION_COOKIE, '', { httpOnly: true, sameSite: 'lax', path: COOKIE_PATH, maxAge: 0 });
}

export function adminToken(): string | null {
  const token = process.env.ADMIN_TOKEN;
  return token && token !== 'change-me' ? token : null;
}

export async function isAdmin(): Promise<boolean> {
  const token = adminToken();
  if (!token) return false;
  return (await cookies()).get(ADMIN_COOKIE)?.value === hashSecret(token);
}

export async function startAdmin(given: string): Promise<boolean> {
  const token = adminToken();
  if (!token || given !== token) return false;
  (await cookies()).set(ADMIN_COOKIE, hashSecret(token), { httpOnly: true, sameSite: 'strict', path: COOKIE_PATH, maxAge: 86_400 });
  return true;
}

export function publicClockOn(): boolean {
  return process.env.PUBLIC_CLOCK !== 'false';
}
