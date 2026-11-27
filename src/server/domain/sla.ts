import type { Priority, TicketStatus } from './types';
import { RESOLVED_STATUSES } from './types';

export interface SlaPolicy {
  readonly firstResponseMinutes: number;
  readonly resolutionMinutes: number;
}

/** Used when a workspace has no row for a priority. */
export const DEFAULT_SLA_POLICIES: Record<Priority, SlaPolicy> = {
  urgent: { firstResponseMinutes: 30, resolutionMinutes: 4 * 60 },
  high: { firstResponseMinutes: 2 * 60, resolutionMinutes: 24 * 60 },
  normal: { firstResponseMinutes: 8 * 60, resolutionMinutes: 3 * 24 * 60 },
  low: { firstResponseMinutes: 24 * 60, resolutionMinutes: 7 * 24 * 60 },
};

export interface SlaDueDates {
  readonly firstResponseDueAt: Date;
  readonly resolutionDueAt: Date;
}

export function computeDueDates(createdAt: Date, policy: SlaPolicy): SlaDueDates {
  return {
    firstResponseDueAt: new Date(createdAt.getTime() + policy.firstResponseMinutes * 60_000),
    resolutionDueAt: new Date(createdAt.getTime() + policy.resolutionMinutes * 60_000),
  };
}

export interface SlaTicketState {
  readonly status: TicketStatus;
  readonly firstResponseAt: Date | null;
  readonly resolvedAt: Date | null;
  readonly firstResponseDueAt: Date | null;
  readonly resolutionDueAt: Date | null;
}

/** Whether the first-response target was missed, as of `now`. */
export function isFirstResponseBreached(ticket: SlaTicketState, now: Date): boolean {
  const due = ticket.firstResponseDueAt;
  if (!due) return false;
  if (ticket.firstResponseAt) return ticket.firstResponseAt.getTime() > due.getTime();
  return now.getTime() >= due.getTime();
}

/** Whether the resolution target was missed, as of `now`. */
export function isResolutionBreached(ticket: SlaTicketState, now: Date): boolean {
  const due = ticket.resolutionDueAt;
  if (!due) return false;
  if (RESOLVED_STATUSES.includes(ticket.status) && ticket.resolvedAt) {
    return ticket.resolvedAt.getTime() > due.getTime();
  }
  return now.getTime() >= due.getTime();
}

export type SlaIndicator =
  | { readonly state: 'met' }
  | { readonly state: 'none' }
  | { readonly state: 'breached'; readonly kind: 'first_response' | 'resolution' }
  | {
      readonly state: 'running';
      readonly kind: 'first_response' | 'resolution';
      readonly dueAt: Date;
    };

/** The single SLA badge shown for a ticket in the inbox. */
export function slaIndicator(ticket: SlaTicketState, now: Date): SlaIndicator {
  if (isFirstResponseBreached(ticket, now)) return { state: 'breached', kind: 'first_response' };
  if (isResolutionBreached(ticket, now)) return { state: 'breached', kind: 'resolution' };
  if (RESOLVED_STATUSES.includes(ticket.status)) return { state: 'met' };
  if (!ticket.firstResponseAt && ticket.firstResponseDueAt) {
    return { state: 'running', kind: 'first_response', dueAt: ticket.firstResponseDueAt };
  }
  if (ticket.resolutionDueAt) {
    return { state: 'running', kind: 'resolution', dueAt: ticket.resolutionDueAt };
  }
  return { state: 'none' };
}
