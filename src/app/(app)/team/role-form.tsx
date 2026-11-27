'use client';

import { useActionState } from 'react';
import { ROLE_LABELS, type Role } from '@/server/domain/types';
import { cx, ui } from '@/lib/ui';
import { updateRole } from './actions';

export function RoleForm({
  userId,
  name,
  role,
  allowedRoles,
}: {
  userId: string;
  name: string;
  role: Role;
  allowedRoles: readonly Role[];
}) {
  const [state, action, pending] = useActionState(updateRole, {});
  const selectId = `role-${userId}`;
  return (
    <form action={action} className="flex flex-wrap items-center justify-end gap-2" key={role}>
      <input type="hidden" name="userId" value={userId} />
      <label htmlFor={selectId} className="sr-only">
        Role for {name}
      </label>
      <select id={selectId} name="role" defaultValue={role} className={cx(ui.input, 'w-auto py-1')}>
        {allowedRoles.map((r) => (
          <option key={r} value={r}>
            {ROLE_LABELS[r]}
          </option>
        ))}
      </select>
      <button type="submit" disabled={pending} className={ui.btnSecondary}>
        Update
      </button>
      {state.error && (
        <p role="alert" className="w-full text-right text-xs text-red-700">
          {state.error}
        </p>
      )}
    </form>
  );
}
