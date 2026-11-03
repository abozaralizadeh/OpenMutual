import { redirect } from 'next/navigation';
import { LoginForm } from '@/components/LoginForm';
import { currentUser } from '@/lib/server';

export default async function Login() {
  if (await currentUser()) redirect('/pool');
  return (
    <div className="card" style={{ maxWidth: 440 }}>
      <h1>Sign in</h1>
      <p className="muted">
        Use any email. We keep a scrambled version of it and nothing else. You&apos;ll get a test wallet with 10,000 test dollars,
        and you won&apos;t have to think about wallets again.
      </p>
      <LoginForm />
    </div>
  );
}
