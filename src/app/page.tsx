import { redirect } from 'next/navigation';
import { getSession } from '@/server/auth/current';

export const dynamic = 'force-dynamic';

export default async function Home() {
  redirect((await getSession()) ? '/inbox' : '/login');
}
