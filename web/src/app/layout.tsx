import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { chainNow, walletNumbers } from '@openmutual/shared';
import { ActionForm } from '@/components/ActionForm';
import { logout, skipClock } from '@/lib/actions';
import { clockTime, money, shortDate } from '@/lib/format';
import { currentUser, getApp, isAdmin, publicClockOn } from '@/lib/server';
import './globals.css';

export const metadata: Metadata = {
  title: 'OpenMutual simulation',
  description: 'A simulation of a distributed mutual. Test money only. Not a real product.',
};

export const dynamic = 'force-dynamic';

function SkipForm({ days, label }: { days: number; label: string }) {
  return (
    <ActionForm action={skipClock} submit={label} quiet className="skip">
      <input type="hidden" name="days" value={days} />
    </ActionForm>
  );
}

export default async function RootLayout({ children }: { children: ReactNode }) {
  const app = getApp();
  const [user, now] = await Promise.all([currentUser(), chainNow(app.client)]);
  const balance = user ? (await walletNumbers(app, user.wallet)).money : null;
  const canSkip = publicClockOn() || (await isAdmin());

  return (
    <html lang="en">
      <body>
        <p className="band">Simulation with test money. Nothing here is insurance or an investment, and nothing here has real value.</p>
        <header className="top">
          <div className="top-inner">
            <Link href="/" className="brand">
              OpenMutual <small>working name</small>
            </Link>
            <nav className="nav" aria-label="Main">
              <Link href="/cover">Get test cover</Link>
              <Link href="/my-covers">My covers</Link>
              <Link href="/pool">Back the pool</Link>
              <Link href="/numbers">Pool numbers</Link>
              <Link href="/community">Community</Link>
            </nav>
            <div className="who">
              {balance !== null ? (
                <>
                  <span data-testid="balance">{money(balance)}</span>
                  <form action={logout}>
                    <button className="button quiet">Sign out</button>
                  </form>
                </>
              ) : (
                <Link href="/login" className="button">Sign in</Link>
              )}
            </div>
          </div>
        </header>
        <div className="clock">
          <div className="clock-inner">
            <span>
              Simulated clock: <strong data-testid="sim-date">{shortDate(now)}</strong>, {clockTime(now)} UTC
            </span>
            {canSkip ? (
              <>
                <SkipForm days={1} label="Skip 1 day" />
                <SkipForm days={7} label="Skip 7 days" />
              </>
            ) : null}
          </div>
        </div>
        <main>{children}</main>
        <footer className="bottom">
          <Link href="/terms">Test terms</Link>
          <Link href="/privacy">Privacy</Link>
          <Link href="/feedback">Feedback</Link>
          <Link href="/admin">Admin</Link>
          <span>Runs on a local test chain only.</span>
        </footer>
      </body>
    </html>
  );
}
