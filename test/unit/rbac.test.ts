import { describe, expect, it } from 'vitest';
import { ForbiddenError } from '../../src/server/domain/errors';
import {
  authorize,
  authorizeAssignment,
  authorizeRoleChange,
  can,
  PERMISSIONS,
  type Permission,
} from '../../src/server/domain/rbac';
import type { Actor, Role } from '../../src/server/domain/types';

const user = (role: Role, userId = `${role}-id`): Actor => ({
  kind: 'user',
  userId,
  role,
  name: role,
});
const system: Actor = { kind: 'system', name: 'worker' };

describe('permission table', () => {
  it.each<[Permission, Role[]]>([
    ['ticket:read', ['owner', 'admin', 'agent']],
    ['ticket:reply', ['owner', 'admin', 'agent']],
    ['ticket:assign_any', ['owner', 'admin']],
    ['members:manage', ['owner', 'admin']],
    ['members:manage_owners', ['owner']],
    ['settings:read', ['owner', 'admin']],
  ])('%s is granted to exactly %j', (permission, roles) => {
    for (const role of ['owner', 'admin', 'agent'] as const) {
      expect(can(user(role), permission)).toBe(roles.includes(role));
    }
  });

  it('owners hold every permission', () => {
    for (const permission of Object.keys(PERMISSIONS) as Permission[]) {
      expect(can(user('owner'), permission)).toBe(true);
    }
  });

  it('trusts the system actor', () => {
    expect(can(system, 'members:manage_owners')).toBe(true);
  });

  it('authorize throws ForbiddenError', () => {
    expect(() => authorize(user('agent'), 'settings:read')).toThrow(ForbiddenError);
  });
});

describe('assignment rules', () => {
  const agent = user('agent', 'me');
  it('lets an agent take an unassigned ticket or drop their own', () => {
    expect(() => authorizeAssignment(agent, null, 'me')).not.toThrow();
    expect(() => authorizeAssignment(agent, 'me', null)).not.toThrow();
  });
  it('stops an agent assigning others or taking someone else’s ticket', () => {
    expect(() => authorizeAssignment(agent, null, 'other')).toThrow(ForbiddenError);
    expect(() => authorizeAssignment(agent, 'other', 'me')).toThrow(ForbiddenError);
    expect(() => authorizeAssignment(agent, 'other', null)).toThrow(ForbiddenError);
  });
  it('lets admins assign anyone', () => {
    expect(() => authorizeAssignment(user('admin'), 'a', 'b')).not.toThrow();
  });
});

describe('role changes', () => {
  it('admins manage agents and admins but not owners', () => {
    expect(() => authorizeRoleChange(user('admin'), 'agent', 'admin')).not.toThrow();
    expect(() => authorizeRoleChange(user('admin'), 'admin', 'agent')).not.toThrow();
    expect(() => authorizeRoleChange(user('admin'), 'agent', 'owner')).toThrow(ForbiddenError);
    expect(() => authorizeRoleChange(user('admin'), 'owner', 'agent')).toThrow(ForbiddenError);
  });
  it('agents cannot change roles at all', () => {
    expect(() => authorizeRoleChange(user('agent'), 'agent', 'agent')).toThrow(ForbiddenError);
  });
  it('owners can grant ownership', () => {
    expect(() => authorizeRoleChange(user('owner'), 'admin', 'owner')).not.toThrow();
  });
});
