'use server';

import { revalidatePath } from 'next/cache';
import { type ActionState, runTenantAction } from '@/server/actions';
import { changeMemberRole } from '@/server/services/members';

export async function updateRole(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const result = await runTenantAction((tx) =>
    changeMemberRole(tx, { userId: formData.get('userId'), role: formData.get('role') }),
  );
  revalidatePath('/team');
  return result;
}
