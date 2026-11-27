'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import type { PresenceViewer, RealtimeEvent } from '@/server/realtime/broker';
import { firstName } from '@/lib/format';
import { Avatar } from './badges';

type ConnectionState = 'connecting' | 'live' | 'reconnecting';

function describe(event: Exclude<RealtimeEvent, { type: 'presence' }>): string {
  const who = firstName(event.actor);
  switch (event.type) {
    case 'ticket.created':
      return `New ticket #${event.number} from ${event.actor}`;
    case 'ticket.updated':
      return `${who} updated ${event.changes.join(', ')} on #${event.number}`;
    case 'ticket.message':
      if (event.authorType === 'customer') return `${event.actor} replied on #${event.number}`;
      return event.internal
        ? `${who} added a note on #${event.number}`
        : `${who} replied on #${event.number}`;
    case 'sla.breached':
      return `SLA breached on #${event.number}`;
  }
}

function viewingSentence(viewers: readonly PresenceViewer[]): string {
  const names = viewers.map((v) => firstName(v.name));
  if (names.length === 1) return `${names[0]} is viewing`;
  if (names.length === 2) return `${names[0]} and ${names[1]} are viewing`;
  return `${names.slice(0, 2).join(', ')} and ${names.length - 2} more are viewing`;
}

/**
 * Subscribes to the workspace event stream. Relevant changes by other people
 * re-render the server components in place (router.refresh keeps client state
 * such as a half-written reply) and are announced through an aria-live region.
 */
export function LiveUpdates({
  view,
  userId,
  ticketId,
}: {
  view: string;
  userId: string;
  ticketId?: string;
}) {
  const router = useRouter();
  const [viewers, setViewers] = useState<readonly PresenceViewer[]>([]);
  const [state, setState] = useState<ConnectionState>('connecting');
  const [notice, setNotice] = useState<{ id: number; text: string } | null>(null);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    const source = new EventSource(`/api/events?view=${encodeURIComponent(view)}`);
    source.onopen = () => setState('live');
    source.onerror = () => setState('reconnecting');
    source.onmessage = (message: MessageEvent<string>) => {
      let event: RealtimeEvent;
      try {
        event = JSON.parse(message.data) as RealtimeEvent;
      } catch {
        return;
      }
      if (event.type === 'presence') {
        setViewers(event.viewers.filter((v) => v.view === view && v.userId !== userId));
        return;
      }
      if (ticketId && event.ticketId !== ticketId) return;
      if (event.actorUserId === userId) return;
      setNotice({ id: Date.now(), text: describe(event) });
      clearTimeout(noticeTimer.current);
      noticeTimer.current = setTimeout(() => setNotice(null), 6000);
      // Coalesce bursts (e.g. reply + status change) into one refresh.
      clearTimeout(refreshTimer.current);
      refreshTimer.current = setTimeout(() => router.refresh(), 250);
    };
    return () => {
      source.close();
      clearTimeout(refreshTimer.current);
      clearTimeout(noticeTimer.current);
    };
  }, [view, userId, ticketId, router]);

  return (
    <div className="flex min-w-0 items-center gap-3">
      {viewers.length > 0 && (
        <div className="flex items-center gap-2" data-testid="presence">
          <div className="flex -space-x-1.5">
            {viewers.slice(0, 4).map((v) => (
              <span key={v.userId} className="rounded-full ring-2 ring-white">
                <Avatar name={v.name} size="sm" />
              </span>
            ))}
          </div>
          <span className="truncate text-xs text-slate-600">{viewingSentence(viewers)}</span>
        </div>
      )}
      <span
        className="inline-flex items-center gap-1.5 text-xs text-slate-500"
        title={state === 'live' ? 'Receiving live updates' : 'Connecting to live updates'}
      >
        <span
          aria-hidden="true"
          className={
            state === 'live'
              ? 'size-2 rounded-full bg-emerald-500'
              : 'size-2 animate-pulse rounded-full bg-amber-400'
          }
        />
        <span data-testid="live-state">{state === 'live' ? 'Live' : 'Connecting'}</span>
      </span>
      <div aria-live="polite" role="status" className="sr-only" data-testid="live-announcer">
        {notice?.text}
      </div>
      {notice && (
        <div
          key={notice.id}
          aria-hidden="true"
          className="fixed right-4 bottom-4 z-50 max-w-sm rounded-lg bg-slate-900 px-4 py-3 text-sm text-white shadow-lg"
          data-testid="live-toast"
        >
          {notice.text}
        </div>
      )}
    </div>
  );
}
