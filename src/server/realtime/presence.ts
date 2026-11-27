import type { PresenceViewer, RealtimeBroker } from './broker';

interface Connection {
  readonly userId: string;
  readonly name: string;
  readonly view: string;
}

/**
 * Who is looking at what, derived from open SSE connections: a stream opened
 * with `?view=ticket:<id>` registers the user as viewing that ticket until the
 * stream closes. No heartbeats or timers are needed because the connection
 * itself is the lease; a crashed tab drops its TCP connection and leaves.
 */
export class PresenceRegistry {
  readonly #byWorkspace = new Map<string, Map<string, Connection>>();
  readonly #broker: RealtimeBroker;

  constructor(broker: RealtimeBroker) {
    this.#broker = broker;
  }

  join(workspaceId: string, connectionId: string, connection: Connection): void {
    let connections = this.#byWorkspace.get(workspaceId);
    if (!connections) {
      connections = new Map();
      this.#byWorkspace.set(workspaceId, connections);
    }
    connections.set(connectionId, connection);
    this.#broadcast(workspaceId);
  }

  leave(workspaceId: string, connectionId: string): void {
    const connections = this.#byWorkspace.get(workspaceId);
    if (!connections?.delete(connectionId)) return;
    if (connections.size === 0) this.#byWorkspace.delete(workspaceId);
    this.#broadcast(workspaceId);
  }

  /** Distinct (user, view) pairs, so two tabs on one ticket count once. */
  viewers(workspaceId: string): PresenceViewer[] {
    const connections = this.#byWorkspace.get(workspaceId);
    if (!connections) return [];
    const seen = new Map<string, PresenceViewer>();
    for (const { userId, name, view } of connections.values()) {
      seen.set(`${userId}|${view}`, { userId, name, view });
    }
    return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  #broadcast(workspaceId: string): void {
    this.#broker.publish(workspaceId, { type: 'presence', viewers: this.viewers(workspaceId) });
  }
}
