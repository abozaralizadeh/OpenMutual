'use client';

import { useActionState } from 'react';
import { finishLogin, startLogin, type ActionState } from '@/lib/actions';

export function LoginForm() {
  const [start, startAction, starting] = useActionState(startLogin, {} as ActionState);
  const [finish, finishAction, finishing] = useActionState(finishLogin, {} as ActionState);
  const email = finish.email ?? start.email;

  if (start.step !== 'code') {
    return (
      <form action={startAction} className="stack">
        <label>
          Email
          <input name="email" type="email" required autoComplete="email" placeholder="you@example.com" />
        </label>
        <div className="form-end">
          <button className="button" disabled={starting}>{starting ? 'Working...' : 'Get a code'}</button>
          {start.error ? <p role="alert" className="note bad">{start.error}</p> : null}
        </div>
      </form>
    );
  }

  return (
    <form action={finishAction} className="stack">
      <input type="hidden" name="email" value={email} />
      {start.code ? (
        <p className="callout">
          No real email goes out in this simulation. Your code is <strong data-testid="login-code">{start.code}</strong>.
        </p>
      ) : null}
      <label>
        Code
        <input name="code" inputMode="numeric" required autoComplete="one-time-code" />
      </label>
      <div className="form-end">
        <button className="button" disabled={finishing}>{finishing ? 'Setting up your test wallet...' : 'Sign in'}</button>
        {finish.error ? <p role="alert" className="note bad">{finish.error}</p> : null}
      </div>
    </form>
  );
}
