import { expect, test } from '@playwright/test';
import { login, openTicket } from '../helpers';

const out = (name: string) => `docs/screenshots/${name}.png`;

test('capture product screenshots', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  await page.goto('/login');
  await page.screenshot({ path: out('login') });

  await login(page, 'alex@acme.test');
  await expect(page.getByTestId('live-state')).toHaveText('Live');
  await page.screenshot({ path: out('inbox') });

  // A second agent on the same ticket, so presence shows up in the capture.
  const samContext = await browser.newContext();
  const sam = await samContext.newPage();
  await login(sam, 'sam@acme.test');
  await openTicket(sam, 'Invoice charged twice this month');

  await openTicket(page, 'Invoice charged twice this month');
  await expect(page.getByTestId('presence')).toHaveText(/Sam is viewing/);
  await page
    .getByLabel(/Reply to Priya Natarajan/)
    .fill(
      'Hi Priya, the refund for the duplicate charge was issued this morning. It can take 5-7 business days to appear on your statement.',
    );
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.screenshot({ path: out('ticket') });
  await page.setViewportSize({ width: 1440, height: 900 });

  await page.goto('/dashboard');
  await expect(page.getByTestId('stat-frt')).toBeVisible();
  await page.screenshot({ path: out('dashboard'), fullPage: true });

  await page.goto('/team');
  await page.screenshot({ path: out('team') });
  await samContext.close();

  const mobile = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
  });
  const phone = await mobile.newPage();
  await login(phone, 'alex@acme.test');
  await phone.screenshot({ path: out('inbox-mobile') });
  await mobile.close();
  await context.close();
});
