import { randomUUID } from 'node:crypto';
import { type APIRequestContext, expect, type Page } from '@playwright/test';
import { DEMO_PASSWORD, DEMO_WEBHOOK_SECRET, DEMO_WORKSPACES } from '../src/server/demo';
import { signPayload } from '../src/server/services/inbound-email';

export async function login(page: Page, email: string): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Work email').fill(email);
  await page.getByLabel('Password').fill(DEMO_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/inbox$/);
}

export async function openTicket(page: Page, subject: string): Promise<void> {
  await page.goto('/inbox?status=all');
  await page.getByRole('link', { name: subject }).click();
  await expect(page.getByTestId('ticket-subject')).toHaveText(subject);
  await expect(page.getByTestId('live-state')).toHaveText('Live');
}

/** Delivers a signed inbound email to the webhook, as an email provider would. */
export async function sendInboundEmail(
  request: APIRequestContext,
  email: { subject: string; text: string; from?: string; name?: string; messageId?: string },
) {
  const body = JSON.stringify({
    messageId: email.messageId ?? `<${randomUUID()}@mail.e2e.test>`,
    from: { email: email.from ?? 'e2e.customer@example.com', name: email.name ?? 'Robin E2E' },
    to: DEMO_WORKSPACES[0].inboundAddress,
    subject: email.subject,
    text: email.text,
  });
  const timestamp = String(Math.floor(Date.now() / 1000));
  return request.post('/api/webhooks/inbound-email', {
    data: body,
    headers: {
      'content-type': 'application/json',
      'x-deskline-timestamp': timestamp,
      'x-deskline-signature': signPayload(DEMO_WEBHOOK_SECRET, timestamp, body),
    },
  });
}
