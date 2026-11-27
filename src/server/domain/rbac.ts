import { ForbiddenError } from './errors';
import type { Actor, Role } from './types';

/**
 * Every permission check in the app goes through this table. Route handlers,
 * server actions and services call `authorize()`; nothing compares role
 * strings inline. The system actor (webhooks, SLA worker) is trusted.
 */
export const PERMISSIONS = {
  'ticket:read': ['owner', 'admin', 'agent'],
  'ticket:reply': ['owner', 'admin', 'agent'],
  'ticket:note': ['owner', 'admin', 'agent'],
  'ticket:update': ['owner', 'admin', 'agent'],
  'ticket:assign_self': ['owner', 'admin', 'agent'],
  'ticket:assign_any': ['owner', 'admin'],
  'ai:suggest': ['owner', 'admin', 'agent'],
  'dashboard:read': ['owner', 'admin', 'agent'],
  'members:read': ['owner', 'admin', 'agent'],
  'members:manage': ['owner', 'admin'],
  'members:manage_owners': ['owner'],
  'settings:read': ['owner', 'admin'],
} as const satisfies Record<string, readonly Role[]>;

export type Permission = keyof typeof PERMISSIONS;

export function can(actor: Actor, permission: Permission): boolean {
  if (actor.kind === 'system') return true;
  return (PERMISSIONS[permission] as readonly Role[]).includes(actor.role);
}

export function authorize(actor: Actor, permission: Permission): void {
  if (!can(actor, permission)) {
    throw new ForbiddenError();
  }
}

/**
 * Assignment rule: anyone may take or drop a ticket for themselves; only
 * admins and owners may assign other people.
 */
export function authorizeAssignment(
  actor: Actor,
  currentAssigneeId: string | null,
  nextAssigneeId: string | null,
): void {
  if (actor.kind === 'system') return;
  const touchesOnlySelf =
    (nextAssigneeId === actor.userId && currentAssigneeId === null) ||
    (nextAssigneeId === actor.userId && currentAssigneeId === actor.userId) ||
    (nextAssigneeId === null && currentAssigneeId === actor.userId);
  if (touchesOnlySelf) {
    authorize(actor, 'ticket:assign_self');
  } else {
    authorize(actor, 'ticket:assign_any');
  }
}

/**
 * Role-change rule: admins manage agents and admins; only owners may grant or
 * revoke the owner role. The last owner cannot be demoted (checked by the
 * service, which knows the owner count).
 */
export function authorizeRoleChange(actor: Actor, fromRole: Role, toRole: Role): void {
  authorize(actor, 'members:manage');
  if (fromRole === 'owner' || toRole === 'owner') {
    authorize(actor, 'members:manage_owners');
  }
}
