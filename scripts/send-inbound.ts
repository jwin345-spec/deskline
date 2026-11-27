/**
 * Simulates an email provider delivering a message to the inbound webhook.
 *
 *   npm run inbound:send -- --from "jane@example.com" --subject "Help" --text "My order is late"
 *   npm run inbound:send -- --reply-to "<message-id>" --text "Any update?"
 *
 * Signs the request exactly like a provider would (HMAC-SHA256 over
 * "<timestamp>.<body>") using the demo workspace's secret.
 */
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { DEMO_WEBHOOK_SECRET, DEMO_WORKSPACES } from '../src/server/seed';
import { signPayload } from '../src/server/services/inbound-email';

const { values } = parseArgs({
  options: {
    url: { type: 'string', default: 'http://localhost:3000' },
    from: { type: 'string', default: 'casey@customer.example' },
    name: { type: 'string', default: 'Casey Morgan' },
    subject: { type: 'string', default: 'Order #4417 has not arrived' },
    text: {
      type: 'string',
      default:
        'Hi, my order was due on Monday and the tracking page has not updated since. Can you check?',
    },
    'reply-to': { type: 'string' },
    'message-id': { type: 'string' },
    secret: { type: 'string', default: DEMO_WEBHOOK_SECRET },
  },
});

const payload = {
  messageId: values['message-id'] ?? `<${randomUUID()}@mail.customer.example>`,
  from: { email: values.from, name: values.name },
  to: DEMO_WORKSPACES[0].inboundAddress,
  subject: values.subject,
  text: values.text,
  ...(values['reply-to']
    ? { inReplyTo: values['reply-to'], references: [values['reply-to']] }
    : {}),
};
const body = JSON.stringify(payload);
const timestamp = String(Math.floor(Date.now() / 1000));
const response = await fetch(new URL('/api/webhooks/inbound-email', values.url), {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'x-deskline-timestamp': timestamp,
    'x-deskline-signature': signPayload(values.secret, timestamp, body),
  },
  body,
});
console.log(response.status, await response.text());
