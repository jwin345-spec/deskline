import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { PageHeader } from '@/components/page-header';
import { cx, ui } from '@/lib/ui';
import { duration } from '@/lib/format';
import { requireSession, tenantContext } from '@/server/auth/current';
import { getContainer } from '@/server/container';
import { withTenant } from '@/server/db/tenant';
import { can } from '@/server/domain/rbac';
import { DEFAULT_SLA_POLICIES } from '@/server/domain/sla';
import { PRIORITIES, PRIORITY_LABELS } from '@/server/domain/types';

export const metadata: Metadata = { title: 'Settings' };
export const dynamic = 'force-dynamic';

export default async function SettingsPage() {
  const session = await requireSession();
  const ctx = tenantContext(session);
  if (!can(ctx.actor, 'settings:read')) notFound();
  const { db } = await getContainer();
  const { workspace, policies } = await withTenant(db, ctx, async (tx) => ({
    workspace: await tx.db
      .selectFrom('workspaces')
      .select(['name', 'slug', 'inboundAddress', 'webhookSecret'])
      .where('id', '=', tx.workspaceId)
      .executeTakeFirstOrThrow(),
    policies: await tx.db
      .selectFrom('slaPolicies')
      .selectAll()
      .where('workspaceId', '=', tx.workspaceId)
      .execute(),
  }));
  const policyFor = (p: (typeof PRIORITIES)[number]) =>
    policies.find((row) => row.priority === p) ?? DEFAULT_SLA_POLICIES[p];
  const maskedSecret = `${workspace.webhookSecret.slice(0, 6)}${'•'.repeat(12)}${workspace.webhookSecret.slice(-4)}`;

  return (
    <>
      <PageHeader title="Settings" description={workspace.name} />
      <div className="grid gap-6 px-4 pb-10 sm:px-6 lg:grid-cols-2 lg:px-8">
        <section className={cx(ui.card, 'p-5')} aria-labelledby="email-h">
          <h2 id="email-h" className="text-sm font-semibold text-slate-900">
            Email channel
          </h2>
          <p className="mt-1 text-sm text-slate-600">
            Your email provider forwards messages to the inbound webhook, signed with the workspace
            secret.
          </p>
          <dl className="mt-4 space-y-3 text-sm">
            <div>
              <dt className="text-slate-500">Support address</dt>
              <dd className="font-mono text-slate-900">{workspace.inboundAddress}</dd>
            </div>
            <div>
              <dt className="text-slate-500">Webhook URL</dt>
              <dd className="font-mono text-slate-900">POST /api/webhooks/inbound-email</dd>
            </div>
            <div>
              <dt className="text-slate-500">Signing secret</dt>
              <dd className="font-mono text-slate-900">{maskedSecret}</dd>
            </div>
            <div>
              <dt className="text-slate-500">Signature</dt>
              <dd className="text-slate-700">
                <code className="font-mono text-xs">
                  X-Deskline-Signature: sha256=HMAC(secret, timestamp + &quot;.&quot; + body)
                </code>
                , with <code className="font-mono text-xs">X-Deskline-Timestamp</code> within 5
                minutes.
              </dd>
            </div>
          </dl>
        </section>
        <section className={cx(ui.card, 'overflow-hidden')} aria-labelledby="sla-h">
          <div className="p-5 pb-3">
            <h2 id="sla-h" className="text-sm font-semibold text-slate-900">
              SLA policies
            </h2>
            <p className="mt-1 text-sm text-slate-600">
              Targets are measured from when the ticket was created, around the clock.
            </p>
          </div>
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs text-slate-500">
              <tr>
                <th scope="col" className="px-5 py-2 font-medium">
                  Priority
                </th>
                <th scope="col" className="px-5 py-2 font-medium">
                  First response
                </th>
                <th scope="col" className="px-5 py-2 font-medium">
                  Resolution
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {[...PRIORITIES].reverse().map((p) => {
                const policy = policyFor(p);
                return (
                  <tr key={p}>
                    <th scope="row" className="px-5 py-2 text-left font-medium text-slate-800">
                      {PRIORITY_LABELS[p]}
                    </th>
                    <td className="px-5 py-2 text-slate-700">
                      {duration(policy.firstResponseMinutes * 60)}
                    </td>
                    <td className="px-5 py-2 text-slate-700">
                      {duration(policy.resolutionMinutes * 60)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      </div>
    </>
  );
}
