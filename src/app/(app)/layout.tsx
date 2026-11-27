import { logout } from '@/app/login/actions';
import { Avatar } from '@/components/badges';
import { Logo } from '@/components/logo';
import { type NavItem, NavLinks } from '@/components/nav-links';
import { requireSession, tenantContext } from '@/server/auth/current';
import { can } from '@/server/domain/rbac';
import { ROLE_LABELS } from '@/server/domain/types';

export const dynamic = 'force-dynamic';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await requireSession();
  const actor = tenantContext(session).actor;
  const items: NavItem[] = [
    { href: '/inbox', label: 'Inbox', icon: 'inbox' },
    { href: '/dashboard', label: 'Dashboard', icon: 'dashboard' },
    { href: '/team', label: 'Team', icon: 'team' },
    ...(can(actor, 'settings:read')
      ? [{ href: '/settings', label: 'Settings', icon: 'settings' } as const]
      : []),
  ];

  return (
    <div className="min-h-dvh md:flex">
      <a
        href="#main"
        className="sr-only-focusable fixed top-2 left-2 z-50 rounded-md bg-white px-3 py-2 text-sm font-medium shadow"
      >
        Skip to content
      </a>
      <aside className="flex shrink-0 flex-col bg-brand-900 text-white md:sticky md:top-0 md:h-dvh md:w-60">
        <div className="flex items-center justify-between px-4 py-4">
          <Logo className="h-7" inverted />
          <form action={logout} className="md:hidden">
            <button
              type="submit"
              className="rounded-md px-2 py-1 text-sm text-slate-300 hover:bg-white/5 hover:text-white"
            >
              Sign out
            </button>
          </form>
        </div>
        <div className="px-4 pb-3">
          <p className="text-xs tracking-wide text-slate-400 uppercase">Workspace</p>
          <p className="truncate text-sm font-medium text-white" data-testid="workspace-name">
            {session.workspaceName}
          </p>
        </div>
        <nav aria-label="Main" className="overflow-x-auto px-2 pb-2 md:flex-1">
          <NavLinks items={items} />
        </nav>
        <div className="hidden border-t border-white/10 p-3 md:block">
          <div className="flex items-center gap-3">
            <Avatar name={session.name} />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-white" data-testid="current-user">
                {session.name}
              </p>
              <p className="truncate text-xs text-slate-400">{ROLE_LABELS[session.role]}</p>
            </div>
          </div>
          <form action={logout} className="mt-3">
            <button
              type="submit"
              className="w-full rounded-md px-3 py-1.5 text-left text-sm text-slate-300 hover:bg-white/5 hover:text-white"
            >
              Sign out
            </button>
          </form>
        </div>
      </aside>
      <main id="main" className="min-w-0 flex-1">
        {children}
      </main>
    </div>
  );
}
