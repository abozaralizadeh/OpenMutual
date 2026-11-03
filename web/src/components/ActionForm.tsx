'use client';

import { useActionState, type ReactNode } from 'react';
import type { ActionState } from '@/lib/actions';

interface Props {
  action: (state: ActionState, form: FormData) => Promise<ActionState>;
  submit: string;
  children?: ReactNode;
  quiet?: boolean;
  className?: string;
}

/** A form that shows its working state and its result in place. */
export function ActionForm({ action, submit, children, quiet, className }: Props) {
  const [state, formAction, pending] = useActionState(action, {});
  return (
    <form action={formAction} className={className ?? 'stack'}>
      {children}
      <div className="form-end">
        <button type="submit" className={quiet ? 'button quiet' : 'button'} disabled={pending}>
          {pending ? 'Working...' : submit}
        </button>
        {state.error ? <p role="alert" className="note bad">{state.error}</p> : null}
        {state.ok ? <p role="status" className="note good">{state.ok}</p> : null}
      </div>
    </form>
  );
}
