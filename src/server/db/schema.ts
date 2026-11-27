import type { ColumnType, Generated } from 'kysely';
import type { Priority, Role, TicketStatus } from '../domain/types';

/** Timestamp columns: read as Date, written as Date or a SQL expression. */
type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;
type NullableTimestamp = ColumnType<
  Date | null,
  Date | string | null | undefined,
  Date | string | null
>;
type Json<T> = ColumnType<T, string | undefined, string>;

export interface WorkspacesTable {
  id: Generated<string>;
  slug: string;
  name: string;
  inboundAddress: string;
  webhookSecret: string;
  ticketSeq: Generated<number>;
  createdAt: Timestamp;
}

export interface UsersTable {
  id: Generated<string>;
  email: string;
  name: string;
  passwordHash: string;
  createdAt: Timestamp;
}

export interface MembershipsTable {
  workspaceId: string;
  userId: string;
  role: Role;
  createdAt: Timestamp;
}

export interface SessionsTable {
  id: string;
  userId: string;
  workspaceId: string;
  createdAt: Timestamp;
  expiresAt: Timestamp;
}

export interface CustomersTable {
  id: Generated<string>;
  workspaceId: string;
  email: string;
  name: string | null;
  createdAt: Timestamp;
}

export interface SlaPoliciesTable {
  workspaceId: string;
  priority: Priority;
  firstResponseMinutes: number;
  resolutionMinutes: number;
}

export interface TicketsTable {
  id: Generated<string>;
  workspaceId: string;
  number: number;
  subject: string;
  status: ColumnType<TicketStatus, TicketStatus | undefined, TicketStatus>;
  priority: ColumnType<Priority, Priority | undefined, Priority>;
  customerId: string;
  assigneeId: string | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  lastActivityAt: Timestamp;
  firstResponseAt: NullableTimestamp;
  resolvedAt: NullableTimestamp;
  firstResponseDueAt: NullableTimestamp;
  resolutionDueAt: NullableTimestamp;
  searchVector: ColumnType<string, never, never>;
}

export type MessageAuthorType = 'customer' | 'agent' | 'system';

export interface MessagesTable {
  id: Generated<string>;
  workspaceId: string;
  ticketId: string;
  authorType: MessageAuthorType;
  authorUserId: string | null;
  customerId: string | null;
  body: string;
  internal: ColumnType<boolean, boolean | undefined, boolean>;
  emailMessageId: string | null;
  createdAt: Timestamp;
}

export interface InboundEmailsTable {
  workspaceId: string;
  messageId: string;
  ticketId: string;
  outcome: 'created' | 'threaded';
  receivedAt: Timestamp;
}

export type ActorType = 'user' | 'customer' | 'system';

export interface AuditEventsTable {
  id: Generated<string>;
  workspaceId: string;
  ticketId: string | null;
  actorType: ActorType;
  actorUserId: string | null;
  action: string;
  data: Json<Record<string, unknown>>;
  createdAt: Timestamp;
}

export type SlaKind = 'first_response' | 'resolution';

export interface SlaBreachesTable {
  id: Generated<string>;
  workspaceId: string;
  ticketId: string;
  kind: SlaKind;
  dueAt: Timestamp;
  breachedAt: Timestamp;
}

export type JobStatus = 'queued' | 'running' | 'done' | 'failed';

export interface JobsTable {
  id: Generated<string>;
  workspaceId: string | null;
  kind: string;
  payload: Json<Record<string, unknown>>;
  status: ColumnType<JobStatus, JobStatus | undefined, JobStatus>;
  runAt: Timestamp;
  attempts: Generated<number>;
  maxAttempts: Generated<number>;
  lockedBy: string | null;
  lockedUntil: NullableTimestamp;
  lastError: string | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface Database {
  workspaces: WorkspacesTable;
  users: UsersTable;
  memberships: MembershipsTable;
  sessions: SessionsTable;
  customers: CustomersTable;
  slaPolicies: SlaPoliciesTable;
  tickets: TicketsTable;
  messages: MessagesTable;
  inboundEmails: InboundEmailsTable;
  auditEvents: AuditEventsTable;
  slaBreaches: SlaBreachesTable;
  jobs: JobsTable;
}
