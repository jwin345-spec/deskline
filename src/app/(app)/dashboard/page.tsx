import type { Metadata } from 'next';
import Link from 'next/link';
import { LiveUpdates } from '@/components/live-updates';
import { PageHeader } from '@/components/page-header';
import { duration, relativeTime } from '@/lib/format';
import { cx, ui } from '@/lib/ui';
import { requireSession, tenantContext } from '@/server/auth/current';
import { getContainer } from '@/server/container';
import { withTenant } from '@/server/db/tenant';
import { PRIORITIES, PRIORITY_LABELS, STATUS_LABELS, TICKET_STATUSES } from '@/server/domain/types';
import { getDashboard } from '@/server/services/dashboard';

export const metadata: Metadata = { title: 'Dashboard' };
export const dynamic = 'force-dynamic';

function StatTile({
  label,
  value,
  detail,
  testId,
}: {
  label: string;
  value: string;
  detail: string;
  testId: string;
}) {
  return (
    <div className={cx(ui.card, 'p-5')} data-testid={testId}>
      <p className="text-sm font-medium text-slate-600">{label}</p>
      <p className="mt-2 text-3xl font-semibold tracking-tight text-slate-900 tabular-nums">
        {value}
      </p>
      <p className="mt-1 text-xs text-slate-500">{detail}</p>
    </div>
  );
}

/**
 * Single-series horizontal bars: one hue, value printed beside every bar
 * (the list doubles as the table view), category names in text ink.
 */
function BarList({
  title,
  rows,
  caption,
}: {
  title: string;
  rows: readonly { label: string; value: number }[];
  caption: string;
}) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <section className={cx(ui.card, 'p-5')} aria-labelledby={`${title}-h`}>
      <h2 id={`${title}-h`} className="text-sm font-semibold text-slate-900">
        {title}
      </h2>
      <p className="mt-0.5 text-xs text-slate-500">{caption}</p>
      <dl className="mt-4 space-y-3">
        {rows.map((row) => (
          <div
            key={row.label}
            className="grid grid-cols-[6rem_minmax(0,1fr)_2.5rem] items-center gap-3"
          >
            <dt className="text-sm text-slate-700">{row.label}</dt>
            <dd className="contents">
              <span className="h-2.5 rounded-sm bg-slate-100" aria-hidden="true">
                <span
                  className="block h-full rounded-sm bg-brand-500"
                  style={{
                    width: `${(row.value / max) * 100}%`,
                    minWidth: row.value > 0 ? '4px' : 0,
                  }}
                  title={`${row.label}: ${row.value}`}
                />
              </span>
              <span className="text-right text-sm font-medium text-slate-900 tabular-nums">
                {row.value}
              </span>
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

export default async function DashboardPage() {
  const session = await requireSession();
  const { db } = await getContainer();
  const now = new Date();
  const stats = await withTenant(db, tenantContext(session), (tx) => getDashboard(tx, now));
  const active = stats.byStatus.open + stats.byStatus.pending;

  return (
    <>
      <PageHeader
        title="Dashboard"
        description="Computed live from this workspace's tickets."
        actions={<LiveUpdates view="dashboard" userId={session.userId} />}
      />
      <div className="space-y-6 px-4 pb-10 sm:px-6 lg:px-8">
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <StatTile
            label="Active tickets"
            value={String(active)}
            detail={`${stats.byStatus.open} open, ${stats.byStatus.pending} pending, ${stats.unassignedOpen} unassigned`}
            testId="stat-active"
          />
          <StatTile
            label="Median first response"
            value={
              stats.medianFirstResponseSeconds === null
                ? '—'
                : duration(stats.medianFirstResponseSeconds)
            }
            detail={`Across ${stats.respondedLast30Days} tickets answered, last 30 days`}
            testId="stat-frt"
          />
          <StatTile
            label="SLA breaches"
            value={String(stats.breachesLast7Days)}
            detail="Recorded by the SLA worker, last 7 days"
            testId="stat-breaches"
          />
          <StatTile
            label="Active tickets in breach"
            value={String(stats.activeTicketsInBreach)}
            detail="Open or pending with a missed target"
            testId="stat-in-breach"
          />
        </div>

        <div className="grid gap-6 lg:grid-cols-2">
          <BarList
            title="Tickets by status"
            caption="All tickets in the workspace"
            rows={TICKET_STATUSES.map((s) => ({
              label: STATUS_LABELS[s],
              value: stats.byStatus[s],
            }))}
          />
          <BarList
            title="Active tickets by priority"
            caption="Open and pending only"
            rows={[...PRIORITIES]
              .reverse()
              .map((p) => ({ label: PRIORITY_LABELS[p], value: stats.openByPriority[p] }))}
          />
        </div>

        <section className={cx(ui.card, 'overflow-hidden')} aria-labelledby="breaches-h">
          <div className="border-b border-slate-100 px-5 py-4">
            <h2 id="breaches-h" className="text-sm font-semibold text-slate-900">
              Recent SLA breaches
            </h2>
          </div>
          {stats.recentBreaches.length === 0 ? (
            <p className="px-5 py-8 text-center text-sm text-slate-500">
              No breaches recorded. Nice work.
            </p>
          ) : (
            <ul className="divide-y divide-slate-100">
              {stats.recentBreaches.map((b) => (
                <li
                  key={`${b.ticketId}-${b.kind}`}
                  className="flex items-center justify-between gap-4 px-5 py-3"
                >
                  <div className="min-w-0">
                    <Link
                      href={`/tickets/${b.ticketId}`}
                      className="truncate text-sm font-medium text-slate-900 hover:underline"
                    >
                      <span className="font-mono text-xs text-slate-500">#{b.number}</span>{' '}
                      {b.subject}
                    </Link>
                    <p className="text-xs text-slate-500">
                      {b.kind === 'first_response' ? 'First response' : 'Resolution'} target missed
                    </p>
                  </div>
                  <time
                    dateTime={b.breachedAt.toISOString()}
                    className="shrink-0 text-xs text-slate-500"
                  >
                    {relativeTime(b.breachedAt, now)}
                  </time>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </>
  );
}
