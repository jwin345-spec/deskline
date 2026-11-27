import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { Logo } from '@/components/logo';
import { getSession } from '@/server/auth/current';
import { ROLE_LABELS } from '@/server/domain/types';
import { DEMO_USERS, DEMO_WORKSPACES } from '@/server/demo';
import { LoginForm } from './login-form';

export const metadata: Metadata = { title: 'Sign in' };
export const dynamic = 'force-dynamic';

export default async function LoginPage() {
  if (await getSession()) redirect('/inbox');
  const demoUsers = DEMO_USERS.map((u) => ({
    email: u.email,
    label: `${ROLE_LABELS[u.role]}, ${DEMO_WORKSPACES.find((w) => w.slug === u.workspace)?.name ?? u.workspace}`,
  }));
  return (
    <main className="flex min-h-dvh items-center justify-center bg-gradient-to-br from-brand-50 via-white to-slate-100 px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center text-center">
          <Logo className="h-9" />
          <h1 className="mt-6 text-xl font-semibold text-slate-900">Sign in to your workspace</h1>
          <p className="mt-1 text-sm text-slate-600">The shared inbox for support teams.</p>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          <LoginForm demoUsers={demoUsers} />
        </div>
      </div>
    </main>
  );
}
