'use server';

import { revalidatePath } from 'next/cache';
import { type ActionState, runTenantAction } from '@/server/actions';
import {
  addInternalNote,
  assignTicket,
  changePriority,
  changeStatus,
  replyToTicket,
} from '@/server/services/tickets';

// Server Actions are POST endpoints with Next.js' built-in Origin/Host check
// (CSRF). Every input is re-validated by the service's Zod schema; nothing from
// FormData is trusted as typed.

function field(formData: FormData, name: string): string | undefined {
  const value = formData.get(name);
  return typeof value === 'string' ? value : undefined;
}

export async function sendMessage(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const ticketId = field(formData, 'ticketId') ?? '';
  const mode = field(formData, 'mode');
  const body = field(formData, 'body');
  const result = await runTenantAction((tx, deps) =>
    mode === 'note'
      ? addInternalNote(tx, deps, { ticketId, body })
      : replyToTicket(tx, deps, {
          ticketId,
          body,
          statusAfter: field(formData, 'statusAfter') || undefined,
          aiAssisted: field(formData, 'aiAssisted') === 'true',
        }),
  );
  revalidatePath(`/tickets/${ticketId}`);
  return result;
}

/** Applies status, priority and assignee from the properties panel in one transaction. */
export async function updateProperties(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const ticketId = field(formData, 'ticketId') ?? '';
  const assignee = field(formData, 'assigneeId');
  const result = await runTenantAction(async (tx, deps) => {
    await changeStatus(tx, deps, { ticketId, status: field(formData, 'status') });
    await changePriority(tx, deps, { ticketId, priority: field(formData, 'priority') });
    await assignTicket(tx, deps, { ticketId, assigneeId: assignee ? assignee : null });
  });
  revalidatePath(`/tickets/${ticketId}`);
  return result;
}

export async function setStatus(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const ticketId = field(formData, 'ticketId') ?? '';
  const result = await runTenantAction((tx, deps) =>
    changeStatus(tx, deps, { ticketId, status: field(formData, 'status') }),
  );
  revalidatePath(`/tickets/${ticketId}`);
  return result;
}

export async function assignToMe(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const ticketId = field(formData, 'ticketId') ?? '';
  const result = await runTenantAction((tx, deps, session) =>
    assignTicket(tx, deps, { ticketId, assigneeId: session.userId }),
  );
  revalidatePath(`/tickets/${ticketId}`);
  return result;
}
