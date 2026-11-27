import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant } from '../../src/server/db/tenant';
import { listMessages, findTicket } from '../../src/server/repositories/tickets';
import {
  findWorkspaceByInboundAddress,
  type InboundEmail,
  inboundEmailSchema,
  processInboundEmail,
  signPayload,
  verifySignature,
} from '../../src/server/services/inbound-email';
import { changeStatus, replyToTicket } from '../../src/server/services/tickets';
import { createTestDatabase, type TestDatabase } from '../helpers/database';
import { createWorkspace, makeDeps, type WorkspaceFixture } from '../helpers/fixtures';

function email(overrides: Partial<InboundEmail> & { messageId: string }): InboundEmail {
  return inboundEmailSchema.parse({
    from: { email: 'jane@customer.example', name: 'Jane Doe' },
    to: 'support@mail.inbound.test',
    subject: 'Order missing',
    text: 'Where is my order?',
    ...overrides,
  });
}

describe('webhook signatures', () => {
  const secret = 'whsec_test';
  const body = '{"hello":"world"}';
  const now = new Date('2026-03-02T09:00:00Z');
  const ts = String(Math.floor(now.getTime() / 1000));

  it('accepts a correct signature', () => {
    expect(
      verifySignature({
        secret,
        rawBody: body,
        timestamp: ts,
        signature: signPayload(secret, ts, body),
        now,
      }),
    ).toBe(true);
  });
  it('rejects a tampered body, wrong secret, or missing headers', () => {
    const sig = signPayload(secret, ts, body);
    expect(
      verifySignature({ secret, rawBody: body + ' ', timestamp: ts, signature: sig, now }),
    ).toBe(false);
    expect(
      verifySignature({ secret: 'other', rawBody: body, timestamp: ts, signature: sig, now }),
    ).toBe(false);
    expect(verifySignature({ secret, rawBody: body, timestamp: null, signature: sig, now })).toBe(
      false,
    );
    expect(verifySignature({ secret, rawBody: body, timestamp: ts, signature: null, now })).toBe(
      false,
    );
  });
  it('rejects stale timestamps (replay window) and a timestamp swapped after signing', () => {
    const old = String(Math.floor(now.getTime() / 1000) - 600);
    expect(
      verifySignature({
        secret,
        rawBody: body,
        timestamp: old,
        signature: signPayload(secret, old, body),
        now,
      }),
    ).toBe(false);
    expect(
      verifySignature({
        secret,
        rawBody: body,
        timestamp: ts,
        signature: signPayload(secret, old, body),
        now,
      }),
    ).toBe(false);
  });
});

describe('inbound email processing', () => {
  let t: TestDatabase;
  let ws: WorkspaceFixture;
  const { deps, events, clock } = makeDeps();

  beforeAll(async () => {
    t = await createTestDatabase();
    ws = await createWorkspace(t.db, 'mail');
  });
  afterAll(() => t.destroy());

  it('routes by the inbound address, case-insensitively', async () => {
    const found = await findWorkspaceByInboundAddress(t.db, 'SUPPORT@mail.inbound.test');
    expect(found?.id).toBe(ws.id);
    expect(await findWorkspaceByInboundAddress(t.db, 'nobody@nowhere.test')).toBeNull();
  });

  it('creates a ticket, customer, SLA targets and jobs for a new email', async () => {
    const result = await processInboundEmail(
      t.db,
      deps,
      ws.id,
      email({ messageId: '<new-1@customer.example>' }),
    );
    expect(result.outcome).toBe('created');
    const ticket = await withTenant(t.db, ws.ctx('agent'), (tx) => findTicket(tx, result.ticketId));
    expect(ticket).toMatchObject({
      subject: 'Order missing',
      status: 'open',
      customerEmail: 'jane@customer.example',
    });
    expect(ticket?.firstResponseDueAt?.getTime()).toBe(clock.now().getTime() + 8 * 3600_000);
    const jobs = await t.db
      .selectFrom('jobs')
      .select(['kind', 'runAt'])
      .where('workspaceId', '=', ws.id)
      .execute();
    expect(jobs).toHaveLength(2);
    expect(events.at(-1)?.event).toMatchObject({
      type: 'ticket.created',
      ticketId: result.ticketId,
    });
  });

  it('is idempotent by message id: redelivery changes nothing', async () => {
    const first = await processInboundEmail(
      t.db,
      deps,
      ws.id,
      email({ messageId: '<dup@customer.example>' }),
    );
    const before = await t.db
      .selectFrom('messages')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .executeTakeFirstOrThrow();
    const again = await processInboundEmail(
      t.db,
      deps,
      ws.id,
      email({ messageId: '<dup@customer.example>' }),
    );
    const third = await processInboundEmail(
      t.db,
      deps,
      ws.id,
      email({ messageId: '<dup@customer.example>', text: 'different body' }),
    );
    const after = await t.db
      .selectFrom('messages')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .executeTakeFirstOrThrow();
    expect(first.outcome).toBe('created');
    expect(again).toEqual({ outcome: 'duplicate', ticketId: first.ticketId, number: first.number });
    expect(third.outcome).toBe('duplicate');
    expect(Number(after.n)).toBe(Number(before.n));
  });

  it('settles concurrent deliveries of the same message on a single ticket', async () => {
    const message = email({ messageId: '<race@customer.example>', subject: 'Race' });
    const results = await Promise.all([
      processInboundEmail(t.db, deps, ws.id, message),
      processInboundEmail(t.db, deps, ws.id, message),
      processInboundEmail(t.db, deps, ws.id, message),
    ]);
    expect(new Set(results.map((r) => r.ticketId)).size).toBe(1);
    expect(results.filter((r) => r.outcome === 'created')).toHaveLength(1);
  });

  it('threads a reply via In-Reply-To onto the agent message it answers, and reopens the ticket', async () => {
    const created = await processInboundEmail(
      t.db,
      deps,
      ws.id,
      email({ messageId: '<thread-1@customer.example>', subject: 'Refund' }),
    );
    clock.advance(60_000);
    const reply = await withTenant(t.db, ws.ctx('agent'), (tx) =>
      replyToTicket(tx, deps, {
        ticketId: created.ticketId,
        body: 'Refund issued',
        statusAfter: 'resolved',
      }),
    );
    clock.advance(60_000);
    const followUp = await processInboundEmail(
      t.db,
      deps,
      ws.id,
      email({
        messageId: '<thread-2@customer.example>',
        subject: 'Re: Refund',
        inReplyTo: reply.emailMessageId,
        references: [reply.emailMessageId],
      }),
    );
    expect(followUp).toMatchObject({ outcome: 'threaded', ticketId: created.ticketId });
    const ticket = await withTenant(t.db, ws.ctx('agent'), (tx) =>
      findTicket(tx, created.ticketId),
    );
    expect(ticket?.status).toBe('open');
    expect(ticket?.resolvedAt).toBeNull();
    const thread = await withTenant(t.db, ws.ctx('agent'), (tx) =>
      listMessages(tx, created.ticketId),
    );
    expect(thread.map((m) => m.authorType)).toEqual(['customer', 'agent', 'customer']);
  });

  it('threads by [#number] subject token only for the same customer', async () => {
    const created = await processInboundEmail(
      t.db,
      deps,
      ws.id,
      email({ messageId: '<tok-1@customer.example>', subject: 'Login issue' }),
    );
    const same = await processInboundEmail(
      t.db,
      deps,
      ws.id,
      email({
        messageId: '<tok-2@customer.example>',
        subject: `Re: Login issue [#${created.number}]`,
      }),
    );
    expect(same).toMatchObject({ outcome: 'threaded', ticketId: created.ticketId });
    const stranger = await processInboundEmail(
      t.db,
      deps,
      ws.id,
      email({
        messageId: '<tok-3@attacker.example>',
        subject: `Re: [#${created.number}]`,
        from: { email: 'mallory@attacker.example' },
      }),
    );
    expect(stranger.outcome).toBe('created');
    expect(stranger.ticketId).not.toBe(created.ticketId);
  });

  it('a pending ticket wakes up when the customer replies', async () => {
    const created = await processInboundEmail(
      t.db,
      deps,
      ws.id,
      email({ messageId: '<p-1@customer.example>', subject: 'Pending' }),
    );
    await withTenant(t.db, ws.ctx('agent'), (tx) =>
      changeStatus(tx, deps, { ticketId: created.ticketId, status: 'pending' }),
    );
    await processInboundEmail(
      t.db,
      deps,
      ws.id,
      email({ messageId: '<p-2@customer.example>', subject: `Re: Pending [#${created.number}]` }),
    );
    const ticket = await withTenant(t.db, ws.ctx('agent'), (tx) =>
      findTicket(tx, created.ticketId),
    );
    expect(ticket?.status).toBe('open');
  });

  it('validates payloads strictly', () => {
    expect(
      inboundEmailSchema.safeParse({
        messageId: 'no-brackets',
        from: { email: 'a@b.c' },
        to: 'x@y.z',
        text: 'hi',
      }).success,
    ).toBe(false);
    expect(
      inboundEmailSchema.safeParse({
        messageId: '<a@b>',
        from: { email: 'not-an-email' },
        to: 'x@y.z',
        text: 'hi',
      }).success,
    ).toBe(false);
    expect(
      inboundEmailSchema.safeParse({
        messageId: '<a@b>',
        from: { email: 'a@b.co' },
        to: 'x@y.co',
        text: '',
      }).success,
    ).toBe(false);
  });
});
