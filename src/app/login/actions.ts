'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { authenticate, createSession, deleteSession, SESSION_COOKIE } from '@/server/auth/sessions';
import { loadConfig } from '@/server/config';
import { getContainer } from '@/server/container';

const loginSchema = z.object({
  email: z.email('Enter a valid email address').max(320),
  password: z.string().min(1, 'Enter your password').max(200),
});

export interface LoginState {
  readonly error?: string;
  readonly email?: string;
}

export async function login(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const rawEmail = formData.get('email');
  const email = typeof rawEmail === 'string' ? rawEmail : '';
  const parsed = loginSchema.safeParse({ email, password: formData.get('password') });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Invalid input', email };
  }
  const { db } = await getContainer();
  const user = await authenticate(db, parsed.data.email, parsed.data.password);
  if (!user) return { error: 'Incorrect email or password', email };

  const { token, expiresAt } = await createSession(db, user.userId, user.workspaceId);
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: loadConfig().COOKIE_SECURE,
    path: '/',
    expires: expiresAt,
  });
  redirect('/inbox');
}

export async function logout(): Promise<void> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) {
    const { db } = await getContainer();
    await deleteSession(db, token);
  }
  jar.delete(SESSION_COOKIE);
  redirect('/login');
}
