import { randomBytes } from 'node:crypto';
import type { Db } from '../../src/server/db/database';
import { type TenantTx, withTenant } from '../../src/server/db/tenant';
import { DEFAULT_SLA_POLICIES } from '../../src/server/domain/sla';
import { PRIORITIES, type Role, type TenantContext } from '../../src/server/domain/types';
import { RealtimeBroker, type RealtimeEvent } from '../../src/server/realtime/broker';
import type { ServiceDeps } from '../../src/server/services/deps';
import { processInboundEmail } from '../../src/server/services/inbound-email';

export class TestClock {
  current: Date;
  constructor(start = new Date('2026-03-02T09:00:00.000Z')) {
    this.current = start;
  }
  now = (): Date => new Date(this.current);
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

export function makeDeps(clock = new TestClock()) {
  const broker = new RealtimeBroker();
  const events: { workspaceId: string; event: RealtimeEvent }[] = [];
  const originalPublish = broker.publish.bind(broker);
  broker.publish = (workspaceId, event) => {
    events.push({ workspaceId, event });
    originalPublish(workspaceId, event);
  };
  const deps: ServiceDeps = { broker, now: clock.now };
  return { deps, clock, broker, events };
}

export interface WorkspaceFixture {
  readonly id: string;
  readonly slug: string;
  readonly inboundAddress: string;
  readonly secret: string;
  readonly users: Record<Role, { id: string; name: string; email: string }>;
  ctx(role: Role): TenantContext;
}

let counter = 0;

/** A workspace with one owner, admin and agent. Passwords are not usable (no scrypt cost). */
export async function createWorkspace(db: Db, slug = `ws${++counter}`): Promise<WorkspaceFixture> {
  const secret = `whsec_${randomBytes(12).toString('hex')}`;
  const inboundAddress = `support@${slug}.inbound.test`;
  const ws = await db
    .insertInto('workspaces')
    .values({ slug, name: `Workspace ${slug}`, inboundAddress, webhookSecret: secret })
    .returning('id')
    .executeTakeFirstOrThrow();
  await db
    .insertInto('slaPolicies')
    .values(
      PRIORITIES.map((priority) => ({
        workspaceId: ws.id,
        priority,
        ...DEFAULT_SLA_POLICIES[priority],
      })),
    )
    .execute();

  const users = {} as Record<Role, { id: string; name: string; email: string }>;
  for (const role of ['owner', 'admin', 'agent'] as const) {
    const email = `${role}@${slug}.test`;
    const name = `${role[0]?.toUpperCase()}${role.slice(1)} ${slug}`;
    const user = await db
      .insertInto('users')
      .values({ email, name, passwordHash: 'x' })
      .returning('id')
      .executeTakeFirstOrThrow();
    await db
      .insertInto('memberships')
      .values({ workspaceId: ws.id, userId: user.id, role })
      .execute();
    users[role] = { id: user.id, name, email };
  }
  return {
    id: ws.id,
    slug,
    inboundAddress,
    secret,
    users,
    ctx: (role) => ({
      workspaceId: ws.id,
      actor: { kind: 'user', userId: users[role].id, role, name: users[role].name },
    }),
  };
}

let mailCounter = 0;

export async function createTicket(
  db: Db,
  deps: ServiceDeps,
  ws: WorkspaceFixture,
  overrides: { subject?: string; text?: string; from?: string; messageId?: string } = {},
) {
  return processInboundEmail(db, deps, ws.id, {
    messageId: overrides.messageId ?? `<m${++mailCounter}.${Date.now()}@mail.test>`,
    from: { email: overrides.from ?? `customer${mailCounter}@example.com`, name: 'Casey Customer' },
    to: ws.inboundAddress,
    subject: overrides.subject ?? `Help needed ${mailCounter}`,
    text: overrides.text ?? 'Something is broken.',
    references: [],
  });
}

export function inTenant<T>(db: Db, ctx: TenantContext, fn: (tx: TenantTx) => Promise<T>) {
  return withTenant(db, ctx, fn);
}
