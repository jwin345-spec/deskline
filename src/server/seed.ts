import { randomBytes } from 'node:crypto';
import { sql } from 'kysely';
import { hashPassword } from './auth/password';
import type { Db } from './db/database';
import { withTenant } from './db/tenant';
import { DEMO_PASSWORD, DEMO_USERS, DEMO_WEBHOOK_SECRET, DEMO_WORKSPACES } from './demo';
import { DEFAULT_SLA_POLICIES } from './domain/sla';
import { PRIORITIES, type Priority, type Role, type TicketStatus } from './domain/types';
import { RealtimeBroker } from './realtime/broker';
import type { ServiceDeps } from './services/deps';
import { processInboundEmail } from './services/inbound-email';
import { JobWorker } from './services/sla-worker';
import {
  addInternalNote,
  assignTicket,
  changePriority,
  changeStatus,
  replyToTicket,
} from './services/tickets';

export { DEMO_PASSWORD, DEMO_USERS, DEMO_WEBHOOK_SECRET, DEMO_WORKSPACES } from './demo';

interface SeedTicket {
  readonly from: { email: string; name: string };
  readonly subject: string;
  readonly body: string;
  /** Hours before "now" the email arrived. */
  readonly ageHours: number;
  readonly priority?: Priority;
  readonly assignee?: string;
  readonly reply?: { by: string; afterMinutes: number; body: string };
  readonly customerFollowUp?: { afterMinutes: number; body: string };
  readonly note?: { by: string; body: string };
  readonly status?: TicketStatus;
}

const ACME_TICKETS: readonly SeedTicket[] = [
  {
    from: { email: 'priya@northwind.example', name: 'Priya Natarajan' },
    subject: 'Invoice charged twice this month',
    body: 'Hi, our card was charged twice for the November invoice (INV-2291). Can you refund the duplicate charge? We are on the Team plan.',
    ageHours: 30,
    priority: 'high',
    assignee: 'alex@acme.test',
    reply: {
      by: 'alex@acme.test',
      afterMinutes: 45,
      body: 'Hi Priya, thanks for flagging this. I can see two charges for INV-2291 and have asked billing to reverse the duplicate. You should see it back on the card within 5-7 business days.\n\nAlex',
    },
    customerFollowUp: {
      afterMinutes: 300,
      body: 'Thanks Alex. Could you send a confirmation once the refund is issued?',
    },
    status: 'open',
  },
  {
    from: { email: 'tom@brightlabs.example', name: 'Tom Okafor' },
    subject: 'SSO login fails with "invalid audience"',
    body: 'Since this morning our team cannot log in through Okta. The error page says "invalid audience". Nothing changed on our side as far as I know.',
    ageHours: 3,
    priority: 'urgent',
    assignee: 'sam@acme.test',
    note: {
      by: 'sam@acme.test',
      body: 'Looks related to the IdP metadata rotation on Tuesday. Checking with the platform team.',
    },
  },
  {
    from: { email: 'lena@fjord.example', name: 'Lena Berg' },
    subject: 'How do I export all tickets to CSV?',
    body: 'Is there a way to export every ticket from last quarter to a CSV file for our compliance review?',
    ageHours: 52,
    priority: 'low',
    reply: {
      by: 'jordan@acme.test',
      afterMinutes: 90,
      body: 'Hi Lena, yes: Settings, then Data export, then choose the date range. The export is emailed to you as a CSV when it is ready.\n\nJordan',
    },
    status: 'resolved',
  },
  {
    from: { email: 'marco@verde.example', name: 'Marco Rossi' },
    subject: 'Webhook deliveries delayed by several minutes',
    body: 'Our order webhooks are arriving 5 to 10 minutes late since yesterday. Is there an incident?',
    ageHours: 14,
    priority: 'high',
  },
  {
    from: { email: 'aisha@kitecloud.example', name: 'Aisha Bello' },
    subject: 'Request to add two seats to our plan',
    body: 'We are onboarding two new support agents next week. Can you add two seats and prorate the cost?',
    ageHours: 6,
    assignee: 'jordan@acme.test',
    reply: {
      by: 'jordan@acme.test',
      afterMinutes: 25,
      body: 'Hi Aisha, happy to help. I have added two seats to your plan; the prorated amount will appear on your next invoice.\n\nJordan',
    },
    status: 'pending',
  },
  {
    from: { email: 'devon@harbor.example', name: 'Devon Clarke' },
    subject: 'API returns 429 even under the rate limit',
    body: 'We are sending about 20 requests per minute and still getting 429 Too Many Requests on /v2/orders. Our limit should be 600 per minute.',
    ageHours: 20,
    priority: 'normal',
    assignee: 'alex@acme.test',
    note: {
      by: 'alex@acme.test',
      body: 'Their key might be on the legacy shared bucket. Need to confirm with infra before replying.',
    },
  },
  {
    from: { email: 'nora@pinecrest.example', name: 'Nora Lindqvist' },
    subject: 'Refund policy for annual plans',
    body: 'If we cancel our annual plan after three months, do we get a refund for the remaining months?',
    ageHours: 75,
    reply: {
      by: 'sam@acme.test',
      afterMinutes: 240,
      body: 'Hi Nora, annual plans can be cancelled at any time and unused full months are refunded pro rata. Let me know if you would like me to start that for you.\n\nSam',
    },
    status: 'closed',
  },
  {
    from: { email: 'kenji@atlas.example', name: 'Kenji Watanabe' },
    subject: 'Dark mode for the agent dashboard?',
    body: 'Feature request: our night shift would love a dark mode in the agent dashboard.',
    ageHours: 100,
    priority: 'low',
    reply: {
      by: 'alex@acme.test',
      afterMinutes: 600,
      body: 'Hi Kenji, thanks for the suggestion. I have passed it to the product team and added your vote.\n\nAlex',
    },
    status: 'resolved',
  },
  {
    from: { email: 'fatima@orbit.example', name: 'Fatima Zahra' },
    subject: 'Password reset email never arrives',
    body: 'I have requested a password reset three times and no email arrived. I checked the spam folder too.',
    ageHours: 10,
    priority: 'high',
  },
  {
    from: { email: 'oliver@quarry.example', name: 'Oliver Grant' },
    subject: 'Attachments over 10 MB fail to upload',
    body: 'When a customer attaches a PDF larger than 10 MB the upload spins forever and then fails without an error.',
    ageHours: 1,
  },
  {
    from: { email: 'sofia@meridian.example', name: 'Sofia Alvarez' },
    subject: 'Can we change the billing contact?',
    body: 'Please change our billing contact from finance-old@meridian.example to ap@meridian.example.',
    ageHours: 0.5,
    priority: 'low',
  },
  {
    from: { email: 'ben@lumen.example', name: 'Ben Hughes' },
    subject: 'Reports page shows wrong time zone',
    body: 'All timestamps on the reports page are in UTC even though our workspace is set to Europe/London.',
    ageHours: 40,
    assignee: 'jordan@acme.test',
    reply: {
      by: 'jordan@acme.test',
      afterMinutes: 180,
      body: 'Hi Ben, thanks for the report. I could reproduce it and have filed a bug with our engineers. I will update you here when a fix ships.\n\nJordan',
    },
    status: 'pending',
  },
];

const GLOBEX_TICKETS: readonly SeedTicket[] = [
  {
    from: { email: 'hank@initech.example', name: 'Hank Scorpio' },
    subject: 'Globex confidential: contract renewal terms',
    body: 'Please send over the renewal terms for our enterprise contract.',
    ageHours: 4,
    priority: 'high',
  },
  {
    from: { email: 'lisa@springfield.example', name: 'Lisa Simpson' },
    subject: 'Invoice address update',
    body: 'Our invoice address has changed. Who do I send the new one to?',
    ageHours: 9,
  },
];

function hoursAgo(now: Date, hours: number): Date {
  return new Date(now.getTime() - hours * 3_600_000);
}

/** Wipes all application data (keeps the schema). */
export async function resetData(db: Db): Promise<void> {
  await sql`truncate workspaces, users, sessions, jobs restart identity cascade`.execute(db);
}

export async function isSeeded(db: Db): Promise<boolean> {
  const row = await db
    .selectFrom('workspaces')
    .select('id')
    .where('slug', '=', 'acme')
    .executeTakeFirst();
  return Boolean(row);
}

/**
 * Creates the demo workspaces, users and tickets through the real services
 * (inbound email, replies, notes, assignment), each with a backdated clock, so
 * the audit log, SLA targets and jobs look exactly as they would in use.
 */
export async function seedDemoData(db: Db, now = new Date()): Promise<void> {
  const passwordHash = await hashPassword(DEMO_PASSWORD);
  const workspaceIds = new Map<string, string>();
  for (const ws of DEMO_WORKSPACES) {
    const row = await db
      .insertInto('workspaces')
      .values({
        slug: ws.slug,
        name: ws.name,
        inboundAddress: ws.inboundAddress,
        webhookSecret:
          ws.slug === 'acme' ? DEMO_WEBHOOK_SECRET : `whsec_${randomBytes(24).toString('hex')}`,
        createdAt: hoursAgo(now, 24 * 90),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    workspaceIds.set(ws.slug, row.id);
    await db
      .insertInto('slaPolicies')
      .values(
        PRIORITIES.map((priority) => ({
          workspaceId: row.id,
          priority,
          ...DEFAULT_SLA_POLICIES[priority],
        })),
      )
      .execute();
  }

  const users = new Map<string, { id: string; name: string; role: Role; workspaceId: string }>();
  for (const [index, u] of DEMO_USERS.entries()) {
    const workspaceId = workspaceIds.get(u.workspace) as string;
    const row = await db
      .insertInto('users')
      .values({
        email: u.email,
        name: u.name,
        passwordHash,
        createdAt: hoursAgo(now, 24 * 90 - index),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await db
      .insertInto('memberships')
      .values({
        workspaceId,
        userId: row.id,
        role: u.role,
        createdAt: hoursAgo(now, 24 * 90 - index),
      })
      .execute();
    users.set(u.email, { id: row.id, name: u.name, role: u.role, workspaceId });
  }

  const broker = new RealtimeBroker();
  const at = (date: Date): ServiceDeps => ({ broker, now: () => date });

  for (const [slug, tickets] of [
    ['acme', ACME_TICKETS],
    ['globex', GLOBEX_TICKETS],
  ] as const) {
    const workspaceId = workspaceIds.get(slug) as string;
    const inbound = DEMO_WORKSPACES.find((w) => w.slug === slug)?.inboundAddress as string;
    const ctxFor = (email: string) => {
      const user = users.get(email);
      if (!user) throw new Error(`unknown seed user ${email}`);
      return {
        workspaceId,
        actor: { kind: 'user', userId: user.id, role: user.role, name: user.name },
      } as const;
    };
    const admin = slug === 'acme' ? 'sam@acme.test' : 'grace@globex.test';

    // Oldest first so ticket numbers follow arrival order.
    const ordered = [...tickets].sort((a, b) => b.ageHours - a.ageHours);
    for (const [i, t] of ordered.entries()) {
      const createdAt = hoursAgo(now, t.ageHours);
      const created = await processInboundEmail(db, at(createdAt), workspaceId, {
        messageId: `<seed-${slug}-${i}@mail.example>`,
        from: t.from,
        to: inbound,
        subject: t.subject,
        text: t.body,
        references: [],
      });
      const ticketId = created.ticketId;
      const step = (minutes: number) => new Date(createdAt.getTime() + minutes * 60_000);

      if (t.priority && t.priority !== 'normal') {
        await withTenant(db, ctxFor(admin), (tx) =>
          changePriority(tx, at(step(2)), { ticketId, priority: t.priority }),
        );
      }
      if (t.assignee) {
        const assigneeId = users.get(t.assignee)?.id as string;
        await withTenant(db, ctxFor(t.assignee), (tx) =>
          assignTicket(tx, at(step(3)), { ticketId, assigneeId }),
        );
      }
      if (t.note) {
        const note = t.note;
        await withTenant(db, ctxFor(note.by), (tx) =>
          addInternalNote(tx, at(step(10)), { ticketId, body: note.body }),
        );
      }
      let replyMessageId: string | undefined;
      if (t.reply) {
        const reply = t.reply;
        const result = await withTenant(db, ctxFor(reply.by), (tx) =>
          replyToTicket(tx, at(step(reply.afterMinutes)), {
            ticketId,
            body: reply.body,
            statusAfter: t.customerFollowUp ? undefined : t.status,
          }),
        );
        replyMessageId = result.emailMessageId;
      }
      if (t.customerFollowUp && replyMessageId) {
        await processInboundEmail(db, at(step(t.customerFollowUp.afterMinutes)), workspaceId, {
          messageId: `<seed-${slug}-${i}-followup@mail.example>`,
          from: t.from,
          to: inbound,
          subject: `Re: ${t.subject} [#${created.number}]`,
          text: t.customerFollowUp.body,
          inReplyTo: replyMessageId,
          references: [replyMessageId],
        });
      } else if (t.status && !t.reply) {
        await withTenant(db, ctxFor(admin), (tx) =>
          changeStatus(tx, at(step(30)), { ticketId, status: t.status }),
        );
      }
    }
  }

  // Let the SLA worker evaluate every target that is already due, so the demo
  // starts with real breach records rather than hand-inserted ones.
  const worker = new JobWorker(db, { broker, now: () => now }, { workerId: 'seed' });
  while ((await worker.tick()) > 0) {
    // drain
  }
}
