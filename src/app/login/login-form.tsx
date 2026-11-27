'use client';

import { useActionState } from 'react';
import { ui } from '@/lib/ui';
import { login, type LoginState } from './actions';

export function LoginForm({
  demoUsers,
}: {
  demoUsers: readonly { email: string; label: string }[];
}) {
  const [state, action, pending] = useActionState<LoginState, FormData>(login, {});
  return (
    <form action={action} className="space-y-4" noValidate>
      <div>
        <label htmlFor="email" className={ui.label}>
          Work email
        </label>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="username"
          required
          defaultValue={state.email ?? 'alex@acme.test'}
          className={ui.input}
          aria-invalid={state.error ? true : undefined}
          aria-describedby={state.error ? 'login-error' : undefined}
        />
      </div>
      <div>
        <label htmlFor="password" className={ui.label}>
          Password
        </label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          defaultValue="deskline-demo"
          className={ui.input}
          aria-invalid={state.error ? true : undefined}
          aria-describedby={state.error ? 'login-error' : undefined}
        />
      </div>
      {state.error && (
        <p
          id="login-error"
          role="alert"
          className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700"
        >
          {state.error}
        </p>
      )}
      <button type="submit" disabled={pending} className={`${ui.btnPrimary} w-full py-2`}>
        {pending ? 'Signing in...' : 'Sign in'}
      </button>
      <details className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
        <summary className="cursor-pointer font-medium text-slate-700">Demo accounts</summary>
        <p className="mt-2">
          Password for all: <code className="font-mono">deskline-demo</code>
        </p>
        <ul className="mt-1 space-y-0.5">
          {demoUsers.map((u) => (
            <li key={u.email}>
              <code className="font-mono">{u.email}</code> ({u.label})
            </li>
          ))}
        </ul>
      </details>
    </form>
  );
}
