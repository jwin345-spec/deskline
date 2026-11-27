import { EventEmitter } from 'node:events';

/** Events pushed to browsers over Server-Sent Events. Never contain message bodies. */
export type RealtimeEvent =
  | {
      readonly type: 'ticket.created';
      readonly ticketId: string;
      readonly number: number;
      readonly subject: string;
      readonly actor: string;
      readonly actorUserId: string | null;
    }
  | {
      readonly type: 'ticket.updated';
      readonly ticketId: string;
      readonly number: number;
      readonly changes: readonly string[];
      readonly actor: string;
      readonly actorUserId: string | null;
    }
  | {
      readonly type: 'ticket.message';
      readonly ticketId: string;
      readonly number: number;
      readonly internal: boolean;
      readonly authorType: 'customer' | 'agent' | 'system';
      readonly actor: string;
      readonly actorUserId: string | null;
    }
  | {
      readonly type: 'sla.breached';
      readonly ticketId: string;
      readonly number: number;
      readonly kind: 'first_response' | 'resolution';
      readonly actor: string;
      readonly actorUserId: null;
    }
  | {
      readonly type: 'presence';
      readonly viewers: readonly PresenceViewer[];
    };

export interface PresenceViewer {
  readonly userId: string;
  readonly name: string;
  /** `inbox`, `dashboard` or `ticket:<uuid>`. */
  readonly view: string;
}

export type Listener = (event: RealtimeEvent) => void;

/**
 * Fan-out of workspace events to connected SSE streams.
 *
 * This implementation is in-process, which is correct for a single Node
 * server (the deployment this repo ships). Publishing happens only from
 * `afterCommit`, so subscribers never hear about a write that rolled back.
 * Scaling out to several instances means swapping this class for one backed
 * by Postgres LISTEN/NOTIFY or Redis pub/sub behind the same interface.
 */
export class RealtimeBroker {
  readonly #emitter = new EventEmitter();

  constructor() {
    // One listener per open browser tab; the default cap of 10 is far too low.
    this.#emitter.setMaxListeners(0);
  }

  publish(workspaceId: string, event: RealtimeEvent): void {
    this.#emitter.emit(workspaceId, event);
  }

  subscribe(workspaceId: string, listener: Listener): () => void {
    this.#emitter.on(workspaceId, listener);
    return () => {
      this.#emitter.off(workspaceId, listener);
    };
  }

  listenerCount(workspaceId: string): number {
    return this.#emitter.listenerCount(workspaceId);
  }
}
