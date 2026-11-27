import type { Metadata } from 'next';
import { Avatar } from '@/components/badges';
import { PageHeader } from '@/components/page-header';
import { cx, ui } from '@/lib/ui';
import { requireSession, tenantContext } from '@/server/auth/current';
import { getContainer } from '@/server/container';
import { withTenant } from '@/server/db/tenant';
import { can } from '@/server/domain/rbac';
import { ROLE_LABELS, ROLES, type Role } from '@/server/domain/types';
import { getMembers } from '@/server/services/members';
import { RoleForm } from './role-form';

export const metadata: Metadata = { title: 'Team' };
export const dynamic = 'force-dynamic';

const ROLE_HELP: Record<Role, string> = {
  owner: 'Everything, including granting and revoking ownership.',
  admin: 'Manage agents and admins, assign any ticket, view settings.',
  agent: 'Work tickets: reply, add notes, change status, assign to self.',
};

export default async function TeamPage() {
  const session = await requireSession();
  const ctx = tenantContext(session);
  const { db } = await getContainer();
  const members = await withTenant(db, ctx, (tx) => getMembers(tx));
  const canManage = can(ctx.actor, 'members:manage');
  const canManageOwners = can(ctx.actor, 'members:manage_owners');

  return (
    <>
      <PageHeader
        title="Team"
        description={`${members.length} members of ${session.workspaceName}`}
      />
      <div className="grid gap-6 px-4 pb-10 sm:px-6 lg:grid-cols-[minmax(0,1fr)_18rem] lg:px-8">
        <section className={cx(ui.card, 'overflow-hidden')} aria-labelledby="members-h">
          <h2 id="members-h" className="sr-only">
            Members
          </h2>
          <ul className="divide-y divide-slate-100" data-testid="members">
            {members.map((m) => {
              const editable = canManage && (canManageOwners || m.role !== 'owner');
              const allowed = canManageOwners ? ROLES : ROLES.filter((r) => r !== 'owner');
              return (
                <li key={m.userId} className="flex flex-wrap items-center gap-4 px-5 py-4">
                  <Avatar name={m.name} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-slate-900">
                      {m.name}
                      {m.userId === session.userId && (
                        <span className="text-slate-500"> (you)</span>
                      )}
                    </p>
                    <p className="truncate text-xs text-slate-500">{m.email}</p>
                  </div>
                  {editable ? (
                    <RoleForm
                      userId={m.userId}
                      name={m.name}
                      role={m.role}
                      allowedRoles={allowed}
                    />
                  ) : (
                    <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-700">
                      {ROLE_LABELS[m.role]}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
        <aside className={cx(ui.card, 'h-fit p-5')} aria-labelledby="roles-h">
          <h2 id="roles-h" className="text-sm font-semibold text-slate-900">
            Roles
          </h2>
          <dl className="mt-3 space-y-3 text-sm">
            {ROLES.map((r) => (
              <div key={r}>
                <dt className="font-medium text-slate-800">{ROLE_LABELS[r]}</dt>
                <dd className="text-slate-600">{ROLE_HELP[r]}</dd>
              </div>
            ))}
          </dl>
          {!canManage && (
            <p className="mt-4 text-xs text-slate-500">Ask an admin or owner to change roles.</p>
          )}
        </aside>
      </div>
    </>
  );
}
