'use client';

import { useActionState, useId, useRef, useState } from 'react';
import type { ActionState } from '@/server/actions';
import type { Priority, TicketStatus } from '@/server/domain/types';
import { PRIORITY_LABELS, STATUS_LABELS } from '@/server/domain/types';
import { cx, ui } from '@/lib/ui';
import { assignToMe, sendMessage, setStatus, updateProperties } from './actions';

const STATUSES: TicketStatus[] = ['open', 'pending', 'resolved', 'closed'];
const PRIORITY_LIST: Priority[] = ['low', 'normal', 'high', 'urgent'];

function FormError({ state, id }: { state: ActionState; id?: string }) {
  if (!state.error) return null;
  return (
    <p id={id} role="alert" className="mt-2 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
      {state.error}
    </p>
  );
}

/** One-click actions in the ticket header (Resolve, Reopen, Assign to me). */
export function QuickAction({
  ticketId,
  kind,
  status,
  label,
  primary = false,
}: {
  ticketId: string;
  kind: 'status' | 'assign-me';
  status?: TicketStatus;
  label: string;
  primary?: boolean;
}) {
  const [state, action, pending] = useActionState(kind === 'status' ? setStatus : assignToMe, {});
  return (
    <form action={action}>
      <input type="hidden" name="ticketId" value={ticketId} />
      {status && <input type="hidden" name="status" value={status} />}
      <button
        type="submit"
        disabled={pending}
        className={primary ? ui.btnPrimary : ui.btnSecondary}
      >
        {label}
      </button>
      {state.error && (
        <span role="alert" className="ml-2 text-sm text-red-700">
          {state.error}
        </span>
      )}
    </form>
  );
}

export function PropertiesForm({
  ticketId,
  status,
  priority,
  assigneeId,
  members,
  canAssignOthers,
  currentUserId,
}: {
  ticketId: string;
  status: TicketStatus;
  priority: Priority;
  assigneeId: string | null;
  members: readonly { userId: string; name: string }[];
  canAssignOthers: boolean;
  currentUserId: string;
}) {
  const [state, action, pending] = useActionState(updateProperties, {});

  // Agents may only pick themselves or nobody, unless the ticket is already
  // someone else's (then it stays selectable so the form round-trips).
  const assignable = members.filter(
    (m) => canAssignOthers || m.userId === currentUserId || m.userId === assigneeId,
  );

  // Keyed on the server values so a live refresh resets the selects.
  const key = `${status}|${priority}|${assigneeId ?? ''}`;
  return (
    <form action={action} className="space-y-3" key={key} aria-label="Ticket properties">
      <input type="hidden" name="ticketId" value={ticketId} />
      <div>
        <label htmlFor="prop-status" className={ui.label}>
          Status
        </label>
        <select id="prop-status" name="status" defaultValue={status} className={ui.input}>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {STATUS_LABELS[s]}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label htmlFor="prop-priority" className={ui.label}>
          Priority
        </label>
        <select id="prop-priority" name="priority" defaultValue={priority} className={ui.input}>
          {PRIORITY_LIST.map((p) => (
            <option key={p} value={p}>
              {PRIORITY_LABELS[p]}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label htmlFor="prop-assignee" className={ui.label}>
          Assignee
        </label>
        <select
          id="prop-assignee"
          name="assigneeId"
          defaultValue={assigneeId ?? ''}
          className={ui.input}
        >
          <option value="">Unassigned</option>
          {assignable.map((m) => (
            <option key={m.userId} value={m.userId}>
              {m.name}
              {m.userId === currentUserId ? ' (you)' : ''}
            </option>
          ))}
        </select>
        {!canAssignOthers && (
          <p className="mt-1 text-xs text-slate-500">Agents can assign tickets to themselves.</p>
        )}
      </div>
      <div className="flex items-center gap-3">
        <button type="submit" disabled={pending} className={ui.btnPrimary}>
          {pending ? 'Saving...' : 'Save changes'}
        </button>
        <span role="status" className="text-sm text-emerald-700">
          {state.ok && !pending ? 'Saved' : ''}
        </span>
      </div>
      <FormError state={state} />
    </form>
  );
}

type Mode = 'reply' | 'note';

export function Composer({
  ticketId,
  ticketStatus,
  aiEnabled,
  customerName,
}: {
  ticketId: string;
  ticketStatus: TicketStatus;
  aiEnabled: boolean;
  customerName: string;
}) {
  const [mode, setMode] = useState<Mode>('reply');
  const [body, setBody] = useState('');
  const [aiDraft, setAiDraft] = useState<string | null>(null);
  const [aiStatus, setAiStatus] = useState<{ loading: boolean; error?: string; note?: string }>({
    loading: false,
  });
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const hintId = useId();
  const errorId = useId();

  const [state, action, pending] = useActionState(
    async (prev: ActionState, formData: FormData): Promise<ActionState> => {
      const result = await sendMessage(prev, formData);
      if (result.ok) {
        setBody('');
        setAiDraft(null);
        setAiStatus({ loading: false });
      }
      return result;
    },
    {},
  );

  async function suggest() {
    setAiStatus({ loading: true });
    try {
      const response = await fetch(`/api/tickets/${ticketId}/suggest-reply`, { method: 'POST' });
      const data = (await response.json()) as {
        draft?: string;
        truncated?: boolean;
        detail?: string;
      };
      if (!response.ok || !data.draft) {
        setAiStatus({ loading: false, error: data.detail ?? 'Could not generate a suggestion.' });
        return;
      }
      setMode('reply');
      setBody(data.draft);
      setAiDraft(data.draft);
      setAiStatus({
        loading: false,
        note: data.truncated ? 'The draft was cut short; check the ending.' : undefined,
      });
      textareaRef.current?.focus();
    } catch {
      setAiStatus({ loading: false, error: 'Could not reach the server.' });
    }
  }

  const aiAssisted = aiDraft !== null;
  const tabs: { id: Mode; label: string }[] = [
    { id: 'reply', label: 'Reply to customer' },
    { id: 'note', label: 'Internal note' },
  ];

  return (
    <form
      action={action}
      className={cx(
        'rounded-lg border bg-white shadow-sm',
        mode === 'note' ? 'border-amber-300' : 'border-slate-200',
      )}
      aria-label="Reply or add a note"
    >
      <input type="hidden" name="ticketId" value={ticketId} />
      <input type="hidden" name="mode" value={mode} />
      <input type="hidden" name="aiAssisted" value={String(aiAssisted)} />
      <div
        className="flex items-center gap-1 border-b border-slate-100 px-2 pt-2"
        role="group"
        aria-label="Message type"
      >
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            aria-pressed={mode === tab.id}
            onClick={() => setMode(tab.id)}
            className={cx(
              '-mb-px rounded-t-md border-b-2 px-3 py-2 text-sm font-medium',
              mode === tab.id
                ? tab.id === 'note'
                  ? 'border-amber-500 text-amber-800'
                  : 'border-brand-600 text-brand-700'
                : 'border-transparent text-slate-500 hover:text-slate-800',
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {aiAssisted && mode === 'reply' && (
        <div
          className="mx-3 mt-3 flex items-start gap-2 rounded-md bg-brand-50 px-3 py-2 text-sm text-brand-900"
          data-testid="ai-draft-banner"
        >
          <span aria-hidden="true">✦</span>
          <p>
            AI-suggested draft. Review and edit it before sending; nothing is sent until you click
            Send reply.
          </p>
        </div>
      )}

      <div className="p-3">
        <label htmlFor="composer-body" className="sr-only">
          {mode === 'note' ? 'Internal note' : `Reply to ${customerName}`}
        </label>
        <textarea
          ref={textareaRef}
          id="composer-body"
          name="body"
          rows={6}
          required
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder={
            mode === 'note'
              ? 'Only your team can see notes.'
              : `Write a reply to ${customerName}...`
          }
          aria-describedby={cx(hintId, state.error && errorId) || undefined}
          className={cx(
            ui.input,
            'resize-y',
            mode === 'note' && 'bg-amber-50/50 focus:border-amber-500 focus:ring-amber-500/30',
          )}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              e.currentTarget.form?.requestSubmit();
            }
          }}
        />
        <p id={hintId} className="mt-1 text-xs text-slate-500">
          {mode === 'note'
            ? 'Internal notes are never shown to the customer and are excluded from search.'
            : 'Ctrl+Enter to send.'}
        </p>
        <FormError state={state} id={errorId} />
        {aiStatus.error && (
          <p role="alert" className="mt-2 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
            {aiStatus.error}
          </p>
        )}
        {aiStatus.note && <p className="mt-2 text-sm text-amber-800">{aiStatus.note}</p>}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 bg-slate-50/60 px-3 py-2.5">
        <div className="flex items-center gap-2">
          {mode === 'reply' && (
            <>
              <button
                type="button"
                onClick={suggest}
                disabled={!aiEnabled || aiStatus.loading}
                aria-describedby={!aiEnabled ? 'ai-disabled-reason' : undefined}
                className={ui.btnSecondary}
              >
                <span aria-hidden="true">✦</span>
                {aiStatus.loading ? 'Drafting...' : 'Suggest reply'}
              </button>
              {!aiEnabled && (
                <span id="ai-disabled-reason" className="text-xs text-slate-500">
                  AI drafts are off: set ANTHROPIC_API_KEY on the server to enable them.
                </span>
              )}
            </>
          )}
        </div>
        <div className="flex items-center gap-2">
          {mode === 'reply' && (
            <>
              <label htmlFor="status-after" className="text-xs whitespace-nowrap text-slate-600">
                Then set
              </label>
              <select
                key={ticketStatus}
                id="status-after"
                name="statusAfter"
                defaultValue={ticketStatus === 'open' ? 'pending' : ''}
                className={cx(ui.input, 'w-auto py-1')}
              >
                <option value="">Keep {STATUS_LABELS[ticketStatus].toLowerCase()}</option>
                {STATUSES.filter((s) => s !== ticketStatus).map((s) => (
                  <option key={s} value={s}>
                    {STATUS_LABELS[s]}
                  </option>
                ))}
              </select>
            </>
          )}
          <button
            type="submit"
            disabled={pending || body.trim().length === 0}
            className={mode === 'note' ? ui.btnNote : ui.btnPrimary}
          >
            {pending ? 'Sending...' : mode === 'note' ? 'Add note' : 'Send reply'}
          </button>
        </div>
      </div>
    </form>
  );
}
