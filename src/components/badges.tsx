import type { SlaIndicator } from '@/server/domain/sla';
import {
  type Priority,
  PRIORITY_LABELS,
  STATUS_LABELS,
  type TicketStatus,
} from '@/server/domain/types';
import { duration, initials } from '@/lib/format';
import { cx } from '@/lib/ui';

const STATUS_STYLES: Record<TicketStatus, string> = {
  open: 'bg-sky-50 text-sky-700 ring-sky-600/20',
  pending: 'bg-amber-50 text-amber-800 ring-amber-600/20',
  resolved: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20',
  closed: 'bg-slate-100 text-slate-600 ring-slate-500/20',
};

export function StatusBadge({ status }: { status: TicketStatus }) {
  return (
    <span
      className={cx(
        'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset',
        STATUS_STYLES[status],
      )}
    >
      {STATUS_LABELS[status]}
    </span>
  );
}

const PRIORITY_DOT: Record<Priority, string> = {
  low: 'bg-slate-300',
  normal: 'bg-sky-400',
  high: 'bg-orange-500',
  urgent: 'bg-red-600',
};

/** Priority is conveyed by text as well as colour. */
export function PriorityBadge({ priority }: { priority: Priority }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-600">
      <span aria-hidden="true" className={cx('size-2 rounded-full', PRIORITY_DOT[priority])} />
      {PRIORITY_LABELS[priority]}
    </span>
  );
}

const KIND_LABEL = { first_response: 'First response', resolution: 'Resolution' } as const;

export function SlaBadge({ indicator, now }: { indicator: SlaIndicator; now: Date }) {
  switch (indicator.state) {
    case 'breached':
      return (
        <span className="inline-flex items-center gap-1 rounded-md bg-red-50 px-1.5 py-0.5 text-xs font-medium text-red-700 ring-1 ring-red-600/20 ring-inset">
          <svg aria-hidden="true" viewBox="0 0 16 16" className="size-3 fill-current">
            <path d="M8 1.5a.75.75 0 0 1 .65.38l6.25 11A.75.75 0 0 1 14.25 14H1.75a.75.75 0 0 1-.65-1.12l6.25-11A.75.75 0 0 1 8 1.5Zm0 4a.75.75 0 0 0-.75.75v3a.75.75 0 0 0 1.5 0v-3A.75.75 0 0 0 8 5.5Zm0 6.75a.9.9 0 1 0 0-1.8.9.9 0 0 0 0 1.8Z" />
          </svg>
          {KIND_LABEL[indicator.kind]} SLA breached
        </span>
      );
    case 'running': {
      const seconds = (indicator.dueAt.getTime() - now.getTime()) / 1000;
      const soon = seconds < 3600;
      return (
        <span
          className={cx(
            'inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-medium ring-1 ring-inset',
            soon
              ? 'bg-amber-50 text-amber-800 ring-amber-600/20'
              : 'bg-slate-50 text-slate-600 ring-slate-500/20',
          )}
        >
          <svg aria-hidden="true" viewBox="0 0 16 16" className="size-3 fill-current">
            <path d="M8 1.5a6.5 6.5 0 1 1 0 13 6.5 6.5 0 0 1 0-13Zm0 2.25a.75.75 0 0 0-.75.75V8c0 .2.08.39.22.53l2 2a.75.75 0 1 0 1.06-1.06L8.75 7.69V4.5A.75.75 0 0 0 8 3.75Z" />
          </svg>
          {indicator.kind === 'first_response' ? 'Reply' : 'Resolve'} in {duration(seconds)}
        </span>
      );
    }
    case 'met':
    case 'none':
      return null;
  }
}

const AVATAR_COLORS = [
  'bg-indigo-100 text-indigo-800',
  'bg-emerald-100 text-emerald-800',
  'bg-amber-100 text-amber-900',
  'bg-rose-100 text-rose-800',
  'bg-sky-100 text-sky-800',
  'bg-violet-100 text-violet-800',
];

function colorFor(key: string): string {
  let hash = 0;
  for (const ch of key) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return AVATAR_COLORS[hash % AVATAR_COLORS.length] ?? 'bg-slate-100 text-slate-700';
}

export function Avatar({
  name,
  size = 'md',
  title,
}: {
  name: string;
  size?: 'sm' | 'md';
  title?: string;
}) {
  return (
    <span
      title={title ?? name}
      aria-hidden="true"
      className={cx(
        'inline-flex shrink-0 items-center justify-center rounded-full font-semibold select-none',
        size === 'sm' ? 'size-6 text-[10px]' : 'size-8 text-xs',
        colorFor(name),
      )}
    >
      {initials(name)}
    </span>
  );
}
