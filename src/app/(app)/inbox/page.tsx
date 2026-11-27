import type { Metadata } from 'next';
import Link from 'next/link';
import { z } from 'zod';
import { Avatar, PriorityBadge, SlaBadge, StatusBadge } from '@/components/badges';
import { LiveUpdates } from '@/components/live-updates';
import { PageHeader } from '@/components/page-header';
import { relativeTime } from '@/lib/format';
import { cx, ui } from '@/lib/ui';
import { requireSession, tenantContext } from '@/server/auth/current';
import { getContainer } from '@/server/container';
import { withTenant } from '@/server/db/tenant';
import { slaIndicator } from '@/server/domain/sla';
import { PRIORITIES, PRIORITY_LABELS, STATUS_LABELS, TICKET_STATUSES } from '@/server/domain/types';
import { decodeCursor } from '@/server/lib/cursor';
import { listMembers } from '@/server/repositories/members';
import { getInbox } from '@/server/services/tickets';

export const metadata: Metadata = { title: 'Inbox' };
export const dynamic = 'force-dynamic';

const one = (v: unknown) => (Array.isArray(v) ? (v[0] as unknown) : v);

const filtersSchema = z.object({
  status: z
    .preprocess(one, z.enum([...TICKET_STATUSES, 'active', 'all']).catch('active'))
    .default('active'),
  priority: z.preprocess(one, z.enum(PRIORITIES).optional().catch(undefined)),
  assignee: z.preprocess(one, z.string().max(64).optional().catch(undefined)),
  q: z.preprocess(one, z.string().max(200).optional().catch(undefined)),
  cursor: z.preprocess(one, z.string().max(400).optional().catch(undefined)),
});

type Filters = z.infer<typeof filtersSchema>;

function hrefWith(filters: Filters, patch: Partial<Filters>) {
  const query: Record<string, string> = {};
  for (const [key, value] of Object.entries({ ...filters, ...patch })) {
    if (value && !(key === 'status' && value === 'active')) query[key] = String(value);
  }
  return { pathname: '/inbox' as const, query };
}

export default async function InboxPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireSession();
  const filters = filtersSchema.parse(await searchParams);
  const { db } = await getContainer();
  const { page, members } = await withTenant(db, tenantContext(session), async (tx) => ({
    page: await getInbox(tx, {
      status: filters.status === 'all' ? undefined : filters.status,
      priority: filters.priority,
      assignee: filters.assignee,
      q: filters.q,
      cursor: decodeCursor(filters.cursor),
      limit: 20,
    }),
    members: await listMembers(tx),
  }));
  const now = new Date();
  const filtered = Boolean(
    filters.q || filters.priority || filters.assignee || filters.status !== 'active',
  );

  return (
    <>
      <PageHeader
        title="Inbox"
        description={`${session.workspaceName} shared inbox`}
        actions={<LiveUpdates view="inbox" userId={session.userId} />}
      />
      <div className="px-4 pb-10 sm:px-6 lg:px-8">
        <form
          role="search"
          aria-label="Filter tickets"
          className="mb-4 flex flex-wrap items-end gap-3 rounded-lg border border-slate-200 bg-white p-3 shadow-sm"
        >
          <div className="min-w-48 flex-1">
            <label htmlFor="q" className={ui.label}>
              Search
            </label>
            <input
              id="q"
              name="q"
              type="search"
              defaultValue={filters.q}
              placeholder="Words, customer email or #number"
              className={ui.input}
            />
          </div>
          <div>
            <label htmlFor="status" className={ui.label}>
              Status
            </label>
            <select id="status" name="status" defaultValue={filters.status} className={ui.input}>
              <option value="active">Open and pending</option>
              {TICKET_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABELS[s]}
                </option>
              ))}
              <option value="all">All statuses</option>
            </select>
          </div>
          <div>
            <label htmlFor="priority" className={ui.label}>
              Priority
            </label>
            <select
              id="priority"
              name="priority"
              defaultValue={filters.priority ?? ''}
              className={ui.input}
            >
              <option value="">Any priority</option>
              {PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {PRIORITY_LABELS[p]}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="assignee" className={ui.label}>
              Assignee
            </label>
            <select
              id="assignee"
              name="assignee"
              defaultValue={filters.assignee ?? ''}
              className={ui.input}
            >
              <option value="">Anyone</option>
              <option value="me">Assigned to me</option>
              <option value="unassigned">Unassigned</option>
              {members.map((m) => (
                <option key={m.userId} value={m.userId}>
                  {m.name}
                </option>
              ))}
            </select>
          </div>
          <div className="flex gap-2">
            <button type="submit" className={ui.btnPrimary}>
              Apply
            </button>
            {filtered && (
              <Link href="/inbox" className={ui.btnGhost}>
                Reset
              </Link>
            )}
          </div>
        </form>

        <section aria-labelledby="ticket-list-heading" className={cx(ui.card, 'overflow-hidden')}>
          <h2 id="ticket-list-heading" className="sr-only">
            Tickets
          </h2>
          {page.items.length === 0 ? (
            <div className="px-6 py-16 text-center">
              <p className="text-sm font-medium text-slate-900">No tickets match these filters</p>
              <p className="mt-1 text-sm text-slate-500">
                Try a different search, or reset the filters to see every open ticket.
              </p>
            </div>
          ) : (
            <ul className="divide-y divide-slate-100" data-testid="ticket-list">
              {page.items.map((t) => (
                <li key={t.id} className="relative transition-colors hover:bg-slate-50">
                  <div className="flex gap-4 px-4 py-3 sm:px-5">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <span className="font-mono text-xs text-slate-500">#{t.number}</span>
                        <Link
                          href={`/tickets/${t.id}`}
                          className="truncate text-sm font-semibold text-slate-900 after:absolute after:inset-0 focus-visible:outline-none"
                        >
                          {t.subject}
                        </Link>
                      </div>
                      <p className="mt-0.5 truncate text-sm text-slate-500">
                        <span className="text-slate-700">{t.customerName ?? t.customerEmail}</span>
                        {t.snippet && <> · {t.snippet}</>}
                      </p>
                      <div className="mt-2 flex flex-wrap items-center gap-3">
                        <StatusBadge status={t.status} />
                        <PriorityBadge priority={t.priority} />
                        <SlaBadge indicator={slaIndicator(t, now)} now={now} />
                      </div>
                    </div>
                    <div className="flex shrink-0 flex-col items-end justify-between gap-2">
                      <time
                        dateTime={t.lastActivityAt.toISOString()}
                        className="text-xs text-slate-500"
                      >
                        {relativeTime(t.lastActivityAt, now)}
                      </time>
                      {t.assigneeName ? (
                        <span className="flex items-center gap-1.5 text-xs text-slate-600">
                          <Avatar name={t.assigneeName} size="sm" />
                          <span className="hidden sm:inline">{t.assigneeName}</span>
                        </span>
                      ) : (
                        <span className="text-xs text-slate-400">Unassigned</span>
                      )}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        <nav aria-label="Pagination" className="mt-4 flex items-center justify-between">
          {filters.cursor ? (
            <Link href={hrefWith(filters, { cursor: undefined })} className={ui.btnGhost}>
              Back to newest
            </Link>
          ) : (
            <span />
          )}
          {page.nextCursor && (
            <Link href={hrefWith(filters, { cursor: page.nextCursor })} className={ui.btnSecondary}>
              Older tickets
            </Link>
          )}
        </nav>
      </div>
    </>
  );
}
