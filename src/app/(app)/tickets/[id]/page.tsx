import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Avatar, PriorityBadge, SlaBadge, StatusBadge } from '@/components/badges';
import { LiveUpdates } from '@/components/live-updates';
import { dateTime, duration, relativeTime } from '@/lib/format';
import { cx, ui } from '@/lib/ui';
import { requireSession, tenantContext } from '@/server/auth/current';
import { aiEnabled, getContainer } from '@/server/container';
import { withTenant } from '@/server/db/tenant';
import { NotFoundError } from '@/server/domain/errors';
import { can } from '@/server/domain/rbac';
import { slaIndicator } from '@/server/domain/sla';
import {
  PRIORITY_LABELS,
  RESOLVED_STATUSES,
  STATUS_LABELS,
  type TicketStatus,
} from '@/server/domain/types';
import type { AuditEntry } from '@/server/repositories/audit';
import { getTicketView } from '@/server/services/tickets';
import { Composer, PropertiesForm, QuickAction } from './client';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Ticket' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function describeAudit(entry: AuditEntry): string {
  const d = entry.data;
  switch (entry.action) {
    case 'ticket.created':
      return `Ticket created from email${str(d.from) ? ` by ${str(d.from)}` : ''}`;
    case 'ticket.replied':
      return d.aiAssisted === true ? 'Replied (started from an AI draft)' : 'Replied to customer';
    case 'ticket.note_added':
      return 'Added an internal note';
    case 'ticket.status_changed':
      return `Status ${STATUS_LABELS[str(d.from) as TicketStatus] ?? str(d.from)} → ${STATUS_LABELS[str(d.to) as TicketStatus] ?? str(d.to)}${d.reason === 'customer_reply' ? ' (customer replied)' : ''}`;
    case 'ticket.priority_changed':
      return `Priority ${PRIORITY_LABELS[str(d.from) as keyof typeof PRIORITY_LABELS] ?? str(d.from)} → ${PRIORITY_LABELS[str(d.to) as keyof typeof PRIORITY_LABELS] ?? str(d.to)}`;
    case 'ticket.assigned':
      return d.to ? `Assigned to ${str(d.toName) ?? 'a teammate'}` : 'Unassigned';
    case 'ticket.customer_replied':
      return 'Customer replied by email';
    case 'sla.first_response':
      return `First response after ${duration(Number(d.seconds ?? 0))}`;
    case 'sla.breached':
      return `${d.kind === 'resolution' ? 'Resolution' : 'First-response'} SLA breached`;
    case 'ai.reply_suggested':
      return d.refused === true
        ? 'AI suggestion declined by the model'
        : 'Requested an AI reply draft';
    default:
      return entry.action;
  }
}

function actorLabel(entry: AuditEntry): string {
  if (entry.actorType === 'customer') return 'Customer';
  if (entry.actorType === 'system') return str(entry.data.system) ?? 'System';
  return entry.actorName ?? 'Former member';
}

export default async function TicketPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const { db } = await getContainer();
  const ctx = tenantContext(session);
  let view;
  try {
    view = await withTenant(db, ctx, (tx) => getTicketView(tx, id));
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }
  const { ticket, messages, audit, members, breaches } = view;
  const now = new Date();
  const customer = ticket.customerName ?? ticket.customerEmail;
  const resolved = RESOLVED_STATUSES.includes(ticket.status);

  return (
    <div className="px-4 pt-5 pb-10 sm:px-6 lg:px-8">
      <nav aria-label="Breadcrumb" className="mb-3 text-sm">
        <Link href="/inbox" className="text-slate-500 hover:text-slate-800">
          ← Inbox
        </Link>
      </nav>
      <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-sm text-slate-500">#{ticket.number}</span>
            <StatusBadge status={ticket.status} />
            <PriorityBadge priority={ticket.priority} />
            <SlaBadge indicator={slaIndicator(ticket, now)} now={now} />
          </div>
          <h1
            className="mt-1 text-2xl font-semibold tracking-tight text-slate-900"
            data-testid="ticket-subject"
          >
            {ticket.subject}
          </h1>
          <p className="mt-1 text-sm text-slate-600">
            {customer} · opened {relativeTime(ticket.createdAt, now)}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <LiveUpdates view={`ticket:${ticket.id}`} userId={session.userId} ticketId={ticket.id} />
          {!ticket.assigneeId && (
            <QuickAction ticketId={ticket.id} kind="assign-me" label="Assign to me" />
          )}
          {resolved ? (
            <QuickAction ticketId={ticket.id} kind="status" status="open" label="Reopen" />
          ) : (
            <QuickAction
              ticketId={ticket.id}
              kind="status"
              status="resolved"
              label="Resolve"
              primary
            />
          )}
        </div>
      </header>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="min-w-0 space-y-6">
          <section aria-labelledby="thread-heading">
            <h2 id="thread-heading" className="sr-only">
              Conversation
            </h2>
            <ol className="space-y-4" data-testid="thread">
              {messages.map((m) => {
                const author = m.authorName ?? (m.authorType === 'customer' ? customer : 'Agent');
                return (
                  <li
                    key={m.id}
                    className={cx(
                      'rounded-lg border p-4 shadow-sm',
                      m.internal
                        ? 'border-amber-200 bg-amber-50'
                        : m.authorType === 'customer'
                          ? 'border-slate-200 bg-white'
                          : 'border-brand-100 bg-brand-50/40',
                    )}
                    data-testid={m.internal ? 'note' : 'message'}
                  >
                    <div className="mb-2 flex flex-wrap items-center gap-2">
                      <Avatar name={author} size="sm" />
                      <span className="text-sm font-medium text-slate-900">{author}</span>
                      <span className="text-xs text-slate-500">
                        {m.internal
                          ? 'Internal note'
                          : m.authorType === 'customer'
                            ? m.authorEmail
                            : 'Agent reply'}
                      </span>
                      <time
                        dateTime={m.createdAt.toISOString()}
                        title={dateTime(m.createdAt)}
                        className="ml-auto text-xs text-slate-500"
                      >
                        {relativeTime(m.createdAt, now)}
                      </time>
                    </div>
                    <p className="text-sm leading-6 whitespace-pre-wrap text-slate-800">{m.body}</p>
                  </li>
                );
              })}
            </ol>
          </section>
          <Composer
            ticketId={ticket.id}
            ticketStatus={ticket.status}
            aiEnabled={aiEnabled()}
            customerName={customer}
          />
        </div>

        <aside className="space-y-4" aria-label="Ticket details">
          <section className={cx(ui.card, 'p-4')} aria-labelledby="props-heading">
            <h2 id="props-heading" className="mb-3 text-sm font-semibold text-slate-900">
              Properties
            </h2>
            <PropertiesForm
              ticketId={ticket.id}
              status={ticket.status}
              priority={ticket.priority}
              assigneeId={ticket.assigneeId}
              members={members.map((m) => ({ userId: m.userId, name: m.name }))}
              canAssignOthers={can(ctx.actor, 'ticket:assign_any')}
              currentUserId={session.userId}
            />
          </section>

          <section className={cx(ui.card, 'p-4')} aria-labelledby="customer-heading">
            <h2 id="customer-heading" className="mb-3 text-sm font-semibold text-slate-900">
              Customer
            </h2>
            <div className="flex items-center gap-3">
              <Avatar name={customer} />
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-slate-900">{customer}</p>
                <p className="truncate text-xs text-slate-500">{ticket.customerEmail}</p>
              </div>
            </div>
          </section>

          <section className={cx(ui.card, 'p-4')} aria-labelledby="sla-heading">
            <h2 id="sla-heading" className="mb-3 text-sm font-semibold text-slate-900">
              SLA
            </h2>
            <dl className="space-y-2 text-sm">
              <div className="flex justify-between gap-2">
                <dt className="text-slate-500">First response due</dt>
                <dd className="text-right text-slate-800">
                  {ticket.firstResponseDueAt ? dateTime(ticket.firstResponseDueAt) : '—'}
                </dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-slate-500">First response</dt>
                <dd className="text-right text-slate-800">
                  {ticket.firstResponseAt
                    ? `after ${duration((ticket.firstResponseAt.getTime() - ticket.createdAt.getTime()) / 1000)}`
                    : 'Waiting'}
                </dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-slate-500">Resolution due</dt>
                <dd className="text-right text-slate-800">
                  {ticket.resolutionDueAt ? dateTime(ticket.resolutionDueAt) : '—'}
                </dd>
              </div>
            </dl>
            {breaches.length > 0 && (
              <ul className="mt-3 space-y-1" data-testid="breaches">
                {breaches.map((b) => (
                  <li key={b.kind} className="rounded-md bg-red-50 px-2 py-1 text-xs text-red-700">
                    {b.kind === 'first_response' ? 'First response' : 'Resolution'} target missed
                    (due {dateTime(b.dueAt)})
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className={cx(ui.card, 'p-4')} aria-labelledby="activity-heading">
            <h2 id="activity-heading" className="mb-3 text-sm font-semibold text-slate-900">
              Activity
            </h2>
            <ol className="space-y-3" data-testid="audit-log">
              {audit.map((entry) => (
                <li key={entry.id} className="text-sm">
                  <p className="text-slate-800">{describeAudit(entry)}</p>
                  <p className="text-xs text-slate-500">
                    {actorLabel(entry)} ·{' '}
                    <time
                      dateTime={entry.createdAt.toISOString()}
                      title={dateTime(entry.createdAt)}
                    >
                      {relativeTime(entry.createdAt, now)}
                    </time>
                  </p>
                </li>
              ))}
            </ol>
          </section>
        </aside>
      </div>
    </div>
  );
}
