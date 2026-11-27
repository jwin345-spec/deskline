export const ROLES = ['owner', 'admin', 'agent'] as const;
export type Role = (typeof ROLES)[number];

export const TICKET_STATUSES = ['open', 'pending', 'resolved', 'closed'] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

export const PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export type Priority = (typeof PRIORITIES)[number];

/** Statuses in which the resolution clock has stopped. */
export const RESOLVED_STATUSES: readonly TicketStatus[] = ['resolved', 'closed'];

export const STATUS_LABELS: Record<TicketStatus, string> = {
  open: 'Open',
  pending: 'Pending',
  resolved: 'Resolved',
  closed: 'Closed',
};

export const PRIORITY_LABELS: Record<Priority, string> = {
  low: 'Low',
  normal: 'Normal',
  high: 'High',
  urgent: 'Urgent',
};

export const ROLE_LABELS: Record<Role, string> = {
  owner: 'Owner',
  admin: 'Admin',
  agent: 'Agent',
};

/** Who is acting. Every tenant-scoped operation carries one of these. */
export type Actor =
  | { readonly kind: 'user'; readonly userId: string; readonly role: Role; readonly name: string }
  | { readonly kind: 'system'; readonly name: string };

export interface TenantContext {
  readonly workspaceId: string;
  readonly actor: Actor;
}
