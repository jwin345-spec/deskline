import { expect, test } from '@playwright/test';
import { login, openTicket, sendInboundEmail } from './helpers';

test.describe('core agent flow', () => {
  test('rejects a wrong password with an accessible error', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('Work email').fill('alex@acme.test');
    await page.getByLabel('Password').fill('not-the-password');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'Incorrect' })).toHaveText(
      'Incorrect email or password',
    );
    await expect(page).toHaveURL(/\/login$/);
  });

  test('login → inbox → open ticket → reply → status change', async ({ page }) => {
    await login(page, 'alex@acme.test');
    await expect(page.getByTestId('workspace-name')).toHaveText('Acme Support');
    await expect(page.getByTestId('ticket-list').getByRole('listitem').first()).toBeVisible();

    // Search narrows the inbox using Postgres full-text search over message bodies.
    await page.getByLabel('Search').fill('spam folder');
    await page.getByRole('button', { name: 'Apply' }).click();
    const rows = page.getByTestId('ticket-list').getByRole('listitem');
    await expect(rows).toHaveCount(1);
    await rows.getByRole('link', { name: 'Password reset email never arrives' }).click();

    await expect(page.getByTestId('ticket-subject')).toHaveText(
      'Password reset email never arrives',
    );

    // The AI button is present but disabled, with the reason, because no API key is set.
    const suggest = page.getByRole('button', { name: 'Suggest reply' });
    await expect(suggest).toBeDisabled();
    await expect(page.getByText(/AI drafts are off/)).toBeVisible();

    // Reply; the composer defaults to moving an open ticket to Pending.
    await page
      .getByLabel(/Reply to Fatima Zahra/)
      .fill(
        'Hi Fatima, I have re-sent the reset link and whitelisted our mail server for your domain.',
      );
    await page.getByRole('button', { name: 'Send reply' }).click();
    const thread = page.getByTestId('thread');
    await expect(thread.getByText('I have re-sent the reset link')).toBeVisible();
    await expect(page.getByLabel(/Reply to Fatima Zahra/)).toHaveValue('');
    await expect(page.getByLabel('Status', { exact: true })).toHaveValue('pending');

    // Internal note: visible to the team, styled differently, never sent.
    await page.getByRole('button', { name: 'Internal note' }).click();
    await page.getByLabel('Internal note').fill('Customer uses a strict corporate spam filter.');
    await page.getByRole('button', { name: 'Add note' }).click();
    await expect(page.getByTestId('note').getByText('strict corporate spam filter')).toBeVisible();

    // Resolve from the header.
    await page.getByRole('button', { name: 'Resolve' }).click();
    await expect(page.getByRole('button', { name: 'Reopen' })).toBeVisible();
    await expect(page.getByLabel('Status', { exact: true })).toHaveValue('resolved');

    // Every change landed in the audit log.
    const audit = page.getByTestId('audit-log');
    await expect(audit.getByText('Replied to customer')).toBeVisible();
    await expect(audit.getByText('Status Pending → Resolved')).toBeVisible();
    await expect(audit.getByText('Added an internal note')).toBeVisible();
    await expect(audit.getByText(/^First response after/)).toBeVisible();
  });

  test('properties panel: priority and self-assignment, with RBAC hints for agents', async ({
    page,
  }) => {
    await login(page, 'jordan@acme.test');
    await openTicket(page, 'Can we change the billing contact?');
    await expect(page.getByText('Agents can assign tickets to themselves.')).toBeVisible();
    await page.getByLabel('Priority').selectOption('high');
    await page.getByLabel('Assignee').selectOption({ label: 'Jordan Patel (you)' });
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Saved' })).toBeVisible();
    const audit = page.getByTestId('audit-log');
    await expect(audit.getByText('Priority Low → High')).toBeVisible();
    await expect(audit.getByText('Assigned to Jordan Patel')).toBeVisible();
  });

  test('a user from another workspace gets a 404 for an Acme ticket', async ({ browser }) => {
    const acme = await browser.newPage();
    await login(acme, 'alex@acme.test');
    await openTicket(acme, 'Webhook deliveries delayed by several minutes');
    const url = acme.url();
    await acme.close();

    const globex = await browser.newPage();
    await login(globex, 'grace@globex.test');
    await expect(globex.getByTestId('workspace-name')).toHaveText('Globex Help Desk');
    await expect(globex.getByText('Webhook deliveries delayed')).toHaveCount(0);
    const response = await globex.goto(url);
    expect(response?.status()).toBe(404);
    await expect(globex.getByRole('heading', { name: 'Not found' })).toBeVisible();
    await globex.close();
  });

  test('webhook rejects unsigned requests', async ({ request }) => {
    const response = await request.post('/api/webhooks/inbound-email', {
      data: { to: 'support@acme.inbound.deskline.test', messageId: '<x@y>', text: 'hi' },
    });
    expect(response.status()).toBe(401);
  });
});

test.describe('real-time collaboration', () => {
  test('two agents see presence and each other’s changes live', async ({ browser, request }) => {
    const alexContext = await browser.newContext();
    const samContext = await browser.newContext();
    const alex = await alexContext.newPage();
    const sam = await samContext.newPage();
    await login(alex, 'alex@acme.test');
    await login(sam, 'sam@acme.test');

    const subject = 'API returns 429 even under the rate limit';
    await openTicket(alex, subject);
    await openTicket(sam, subject);

    // Presence: each sees the other on this ticket.
    await expect(alex.getByTestId('presence')).toHaveText(/Sam is viewing/);
    await expect(sam.getByTestId('presence')).toHaveText(/Alex is viewing/);

    // Sam replies and changes the status; Alex's page updates without a reload.
    await sam
      .getByLabel(/Reply to Devon Clarke/)
      .fill('Hi Devon, your key was on a legacy bucket; fixed now.');
    await sam.getByRole('button', { name: 'Send reply' }).click();
    await expect(
      alex.getByTestId('thread').getByText('your key was on a legacy bucket'),
    ).toBeVisible();
    await expect(alex.getByTestId('live-announcer')).toHaveText(/Sam replied on #/);

    await sam.getByRole('button', { name: 'Resolve' }).click();
    await expect(alex.getByRole('button', { name: 'Reopen' })).toBeVisible();
    await expect(alex.getByLabel('Status', { exact: true })).toHaveValue('resolved');

    // A new inbound email shows up in Alex's inbox live, and is announced.
    await alex.goto('/inbox');
    await expect(alex.getByTestId('live-state')).toHaveText('Live');
    const created = await sendInboundEmail(request, {
      subject: 'Live update check: shipment stuck in customs',
      text: 'Our shipment has been in customs for a week.',
    });
    expect(created.status()).toBe(201);
    await expect(
      alex.getByRole('link', { name: 'Live update check: shipment stuck in customs' }),
    ).toBeVisible();
    await expect(alex.getByTestId('live-announcer')).toHaveText(/New ticket #\d+ from Robin E2E/);

    // Presence follows Sam to the inbox.
    await sam.goto('/inbox');
    await expect(alex.getByTestId('presence')).toHaveText(/Sam is viewing/);

    await alexContext.close();
    await samContext.close();
  });

  test('webhook redelivery is idempotent end to end', async ({ request }) => {
    // Providers retry with the same message id (and a fresh signature).
    const email = {
      subject: 'Idempotency check',
      text: 'Sent twice by the provider.',
      messageId: `<idempotency-${Date.now()}@mail.e2e.test>`,
    };
    const first = await sendInboundEmail(request, email);
    expect(first.status()).toBe(201);
    const firstJson = (await first.json()) as { ticketId: string };
    const retry = await sendInboundEmail(request, email);
    expect(retry.status()).toBe(200);
    expect(await retry.json()).toMatchObject({
      outcome: 'duplicate',
      ticketId: firstJson.ticketId,
    });
  });
});
