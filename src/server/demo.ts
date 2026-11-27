import type { Role } from './domain/types';

export const DEMO_PASSWORD = 'deskline-demo';

export const DEMO_USERS = [
  { email: 'maya@acme.test', name: 'Maya Chen', workspace: 'acme', role: 'owner' },
  { email: 'sam@acme.test', name: 'Sam Rivera', workspace: 'acme', role: 'admin' },
  { email: 'alex@acme.test', name: 'Alex Kim', workspace: 'acme', role: 'agent' },
  { email: 'jordan@acme.test', name: 'Jordan Patel', workspace: 'acme', role: 'agent' },
  { email: 'grace@globex.test', name: 'Grace Liu', workspace: 'globex', role: 'owner' },
] as const satisfies readonly { email: string; name: string; workspace: string; role: Role }[];

export const DEMO_WORKSPACES = [
  { slug: 'acme', name: 'Acme Support', inboundAddress: 'support@acme.inbound.deskline.test' },
  { slug: 'globex', name: 'Globex Help Desk', inboundAddress: 'help@globex.inbound.deskline.test' },
] as const;

/** Fixed secret for the demo workspace so `npm run inbound:send` works out of the box. */
export const DEMO_WEBHOOK_SECRET = 'whsec_demo_acme_local_only';
