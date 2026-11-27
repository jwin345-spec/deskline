import Link from 'next/link';
import { ui } from '@/lib/ui';

export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center px-4 text-center">
      <p className="text-sm font-semibold text-brand-600">404</p>
      <h1 className="mt-2 text-2xl font-semibold text-slate-900">Not found</h1>
      <p className="mt-2 text-sm text-slate-600">
        This page does not exist, or it belongs to a workspace you are not a member of.
      </p>
      <Link href="/inbox" className={`${ui.btnPrimary} mt-6`}>
        Back to inbox
      </Link>
    </main>
  );
}
