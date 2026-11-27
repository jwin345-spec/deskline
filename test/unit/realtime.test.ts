import { describe, expect, it } from 'vitest';
import { RealtimeBroker, type RealtimeEvent } from '../../src/server/realtime/broker';
import { PresenceRegistry } from '../../src/server/realtime/presence';

describe('realtime broker', () => {
  it('delivers events only to subscribers of the same workspace', () => {
    const broker = new RealtimeBroker();
    const a: RealtimeEvent[] = [];
    const b: RealtimeEvent[] = [];
    const unsubscribe = broker.subscribe('ws-a', (e) => a.push(e));
    broker.subscribe('ws-b', (e) => b.push(e));
    broker.publish('ws-a', { type: 'presence', viewers: [] });
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(0);
    unsubscribe();
    broker.publish('ws-a', { type: 'presence', viewers: [] });
    expect(a).toHaveLength(1);
  });
});

describe('presence', () => {
  it('tracks viewers per connection and broadcasts changes', () => {
    const broker = new RealtimeBroker();
    const presence = new PresenceRegistry(broker);
    const seen: RealtimeEvent[] = [];
    broker.subscribe('ws', (e) => seen.push(e));

    presence.join('ws', 'c1', { userId: 'u1', name: 'Alex Kim', view: 'ticket:1' });
    presence.join('ws', 'c2', { userId: 'u1', name: 'Alex Kim', view: 'ticket:1' }); // second tab
    presence.join('ws', 'c3', { userId: 'u2', name: 'Sam Rivera', view: 'inbox' });
    expect(presence.viewers('ws')).toEqual([
      { userId: 'u1', name: 'Alex Kim', view: 'ticket:1' },
      { userId: 'u2', name: 'Sam Rivera', view: 'inbox' },
    ]);

    presence.leave('ws', 'c1');
    expect(presence.viewers('ws')).toHaveLength(2); // the other tab is still open
    presence.leave('ws', 'c2');
    presence.leave('ws', 'c3');
    expect(presence.viewers('ws')).toEqual([]);
    expect(seen.filter((e) => e.type === 'presence')).toHaveLength(6);
    expect(presence.viewers('other-ws')).toEqual([]);
  });
});
