import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { getSession } from '@/server/auth/current';
import { getContainer } from '@/server/container';
import type { RealtimeEvent } from '@/server/realtime/broker';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const viewSchema = z.union([
  z.enum(['inbox', 'dashboard', 'team', 'settings']),
  z.string().regex(/^ticket:[0-9a-f-]{36}$/i),
]);

const HEARTBEAT_MS = 15_000;

/**
 * Server-Sent Events stream of the caller's workspace. SSE rather than
 * WebSockets: traffic is server-to-client only (writes go through server
 * actions), it rides plain HTTP through proxies, and EventSource reconnects
 * by itself. The open stream doubles as the presence lease.
 */
export async function GET(request: Request): Promise<Response> {
  const session = await getSession();
  if (!session) return new Response('Unauthorized', { status: 401 });
  const view = viewSchema.safeParse(new URL(request.url).searchParams.get('view'));
  if (!view.success) return new Response('Invalid view', { status: 400 });

  const { broker, presence } = await getContainer();
  const workspaceId = session.workspaceId;
  const connectionId = randomUUID();
  const encoder = new TextEncoder();
  let cleanup = () => {};

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (chunk: string) => {
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          cleanup();
        }
      };
      const onEvent = (event: RealtimeEvent) => send(`data: ${JSON.stringify(event)}\n\n`);

      send('retry: 3000\n\n');
      const unsubscribe = broker.subscribe(workspaceId, onEvent);
      presence.join(workspaceId, connectionId, {
        userId: session.userId,
        name: session.name,
        view: view.data,
      });
      // Snapshot for this client (join() already broadcast to everyone else).
      onEvent({ type: 'presence', viewers: presence.viewers(workspaceId) });
      const heartbeat = setInterval(() => send(': keep-alive\n\n'), HEARTBEAT_MS);

      let closed = false;
      cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        unsubscribe();
        presence.leave(workspaceId, connectionId);
        try {
          controller.close();
        } catch {
          // already closed
        }
      };
      request.signal.addEventListener('abort', () => cleanup());
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
