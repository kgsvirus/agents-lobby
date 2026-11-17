// Event bus: publish → persisted + subscriber fan-out, shared id ordering,
// replay, boundary validation, corrupt-row tolerance.
import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { migrationsFolder, openDatabase, runMigrations } from '../src/infrastructure/database/client.js';
import { EventBus, type BusEvent } from '../src/infrastructure/events/bus.js';
import type { WireMessage } from '../src/shared/schemas/wire.js';
import { tempDir } from './helpers.js';

function freshBus(dir: string): { bus: EventBus; sqlite: import('better-sqlite3').Database } {
  const { sqlite, db } = openDatabase(join(dir, 'bus.db'));
  runMigrations(db, migrationsFolder());
  return { bus: new EventBus(sqlite), sqlite };
}

function wire(id: number): WireMessage {
  return { id, time: '2026-11-17T00:00:00Z', from: 'human', to: 'boss', text: `m${id}` };
}

describe('EventBus', () => {
  it('publish persists the event and notifies subscribers with a shared ascending id', () => {
    const { bus, sqlite } = freshBus(tempDir());
    const seen: BusEvent[] = [];
    bus.subscribe((event) => seen.push(event));

    const a = bus.publish('message.created', wire(1));
    const b = bus.publish('agent.status_changed', { name: 'dev', status: 'busy' });
    const c = bus.publish('message.created', wire(2));

    expect([a.id, b.id, c.id]).toEqual([1, 2, 3]);
    expect(seen.map((event) => `${event.id}:${event.type}`)).toEqual([
      '1:message.created',
      '2:agent.status_changed',
      '3:message.created',
    ]);
    expect(seen[0]?.payload).toEqual(wire(1));
    expect(seen[1]?.payload).toEqual({ name: 'dev', status: 'busy' });

    const rows = sqlite.prepare('SELECT id, type, payload, ts FROM events ORDER BY id').all() as Array<{
      id: number;
      type: string;
      payload: string;
      ts: string;
    }>;
    expect(rows).toHaveLength(3);
    expect(JSON.parse(rows[2]?.payload ?? 'null')).toEqual(wire(2));
    expect(rows[0]?.ts).toBeTruthy();
  });

  it('replay(after) returns only newer persisted events in id order', () => {
    const { bus } = freshBus(tempDir());
    bus.publish('message.created', wire(1));
    bus.publish('project.updated', { name: 'TaskFlow' });
    bus.publish('message.created', wire(2));

    expect(bus.replay(0).map((event) => event.id)).toEqual([1, 2, 3]);
    expect(bus.replay(1).map((event) => event.id)).toEqual([2, 3]);
    expect(bus.replay(3)).toEqual([]);
    expect(bus.replay(1)[1]?.payload).toEqual(wire(2));
  });

  it('replay skips unknown event types and corrupt payloads without throwing', () => {
    const dir = tempDir();
    const { bus, sqlite } = freshBus(dir);
    bus.publish('message.created', wire(1));
    sqlite.prepare("INSERT INTO events (type, payload, ts) VALUES ('future.type', '{}', 'x')").run();
    sqlite.prepare("INSERT INTO events (type, payload, ts) VALUES ('message.created', 'not-json', 'x')").run();
    sqlite.prepare("INSERT INTO events (type, payload, ts) VALUES ('message.created', '{\"bad\":true}', 'x')").run();
    bus.publish('message.created', wire(2));

    expect(bus.replay(0).map((event) => event.id)).toEqual([1, 5]);
  });

  // `row.type in eventPayloadSchemas` accepted INHERITED names ('toString'):
  // the schema lookup then produced undefined/non-schema values and replay
  // threw instead of skipping. Only own properties are event types.
  it('replay skips prototype-named event types (toString) without throwing', () => {
    const dir = tempDir();
    const { bus, sqlite } = freshBus(dir);
    sqlite.prepare("INSERT INTO events (type, payload, ts) VALUES ('toString', '{}', 'x')").run();
    sqlite.prepare("INSERT INTO events (type, payload, ts) VALUES ('still.unknown', '{}', 'x')").run();
    expect(bus.replay(0)).toEqual([]);
  });

  it('publish rejects invalid payloads (zod boundary) and persists nothing', () => {
    const { bus, sqlite } = freshBus(tempDir());
    // Deliberately-invalid payload passed through a cast to exercise the boundary.
    const bad = { nope: true } as unknown as WireMessage;
    expect(() => bus.publish('message.created', bad)).toThrow();
    expect(() => bus.publish('agent.status_changed', { name: '', status: 'x' })).toThrow();
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM events').get()).toEqual({ n: 0 });
  });

  it('a throwing subscriber does not break publish or other subscribers', () => {
    const { bus, sqlite } = freshBus(tempDir());
    const seen: number[] = [];
    bus.subscribe(() => {
      throw new Error('boom');
    });
    bus.subscribe((event) => seen.push(event.id));
    const event = bus.publish('message.created', wire(1));
    expect(seen).toEqual([event.id]);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM events').get()).toEqual({ n: 1 });
  });

  it('transaction() persists events in-tx and emits exactly once after commit, in id order', () => {
    const { bus, sqlite } = freshBus(tempDir());
    const seen: BusEvent[] = [];
    bus.subscribe((event) => seen.push(event));

    let persistedIds: number[] = [];
    const result = bus.transaction((persist) => {
      // The message write shares the transaction (same connection).
      sqlite
        .prepare('INSERT INTO messages (ts, sender, receiver, body) VALUES (?, ?, ?, ?)')
        .run('2026-11-17T00:00:00Z', 'human', 'boss', 'm1');
      const a = persist('message.created', wire(1));
      const b = persist('agent.status_changed', { name: 'dev', status: 'busy' });
      const c = persist('message.created', wire(2));
      persistedIds = [a.id, b.id, c.id];
      expect(seen).toEqual([]); // nothing announced before commit
      return 'ok';
    });
    expect(result).toBe('ok');
    expect(persistedIds).toEqual([1, 2, 3]);
    expect(seen.map((event) => event.id)).toEqual([1, 2, 3]); // exactly once, id order
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM events').get()).toEqual({ n: 3 });
  });

  it('a rolled-back transaction emits nothing and leaves no replay record', () => {
    const { bus, sqlite } = freshBus(tempDir());
    const seen: BusEvent[] = [];
    bus.subscribe((event) => seen.push(event));

    expect(() =>
      bus.transaction((persist) => {
        sqlite
          .prepare('INSERT INTO messages (ts, sender, receiver, body) VALUES (?, ?, ?, ?)')
          .run('2026-11-17T00:00:00Z', 'human', 'boss', 'gone');
        persist('message.created', wire(1));
        throw new Error('rollback');
      }),
    ).toThrow('rollback');

    // No live emission…
    expect(seen).toEqual([]);
    // …and no persisted record a later replay could resurrect.
    expect(bus.replay(0)).toEqual([]);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM events').get()).toEqual({ n: 0 });
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM messages').get()).toEqual({ n: 0 });
  });

  it('ordering: interleaved publish()/transaction() emissions follow persisted id order', () => {
    const { bus } = freshBus(tempDir());
    const seen: BusEvent[] = [];
    bus.subscribe((event) => seen.push(event));

    bus.publish('message.created', wire(1)); // id 1
    bus.transaction((persist) => {
      persist('message.created', wire(2)); // id 2
      persist('agent.status_changed', { name: 'dev', status: 'busy' }); // id 3
    });
    bus.publish('message.created', wire(3)); // id 4

    expect(seen.map((event) => event.id)).toEqual([1, 2, 3, 4]);
  });

  it('transaction() cannot nest, and publish() inside a transaction is refused', () => {
    const { bus } = freshBus(tempDir());
    bus.transaction(() => {
      expect(() => bus.transaction(() => null)).toThrow(/cannot nest/);
      expect(() => bus.publish('message.created', wire(1))).toThrow(/use EventBus\.transaction\(\)/);
      return null;
    });
  });

  it('a retained persist handle is dead after its callback returns (no store-without-fanout)', () => {
    const { bus, sqlite } = freshBus(tempDir());
    const seen: BusEvent[] = [];
    bus.subscribe((event) => seen.push(event));

    let retained: ((type: 'message.created', payload: WireMessage) => BusEvent) | undefined;
    bus.transaction((persist) => {
      retained = persist;
      return persist('message.created', wire(1)); // id 1 — committed + emitted
    });
    expect(seen.map((event) => event.id)).toEqual([1]);

    // Late call after the callback returned: rejected, nothing stored.
    expect(() => retained?.('message.created', wire(2))).toThrow(/persist handle used outside/);
    expect(seen.map((event) => event.id)).toEqual([1]);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM events').get()).toEqual({ n: 1 });
  });

  it('a persist handle from tx A is rejected when called inside tx B (no store-without-fanout)', () => {
    const { bus, sqlite } = freshBus(tempDir());
    const seen: BusEvent[] = [];
    bus.subscribe((event) => seen.push(event));

    let stale: ((type: 'message.created', payload: WireMessage) => BusEvent) | undefined;
    bus.transaction((persist) => {
      stale = persist;
      persist('message.created', wire(1)); // id 1 — committed + emitted
      return null;
    });
    expect(seen.map((event) => event.id)).toEqual([1]);

    // Retained handle called while a DIFFERENT transaction is active: a shared
    // "some callback active" flag would accept it — event id 2 would commit in
    // tx B but append to tx A's dead queue (no fan-out; a later higher id moves
    // an SSE cursor past it). Each handle must be bound to its own transaction.
    expect(() =>
      bus.transaction((persist) => {
        expect(() => stale?.('message.created', wire(2))).toThrow(/persist handle used outside/);
        persist('agent.status_changed', { name: 'dev', status: 'busy' }); // id 2 — tx B's own handle works
        return null;
      }),
    ).not.toThrow();

    expect(seen.map((event) => event.id)).toEqual([1, 2]);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM events').get()).toEqual({ n: 2 });
  });

  it('a reentrant publish during a transaction batch cannot overtake the rest of the batch', () => {
    const { bus } = freshBus(tempDir());
    const received: number[][] = [[], []];
    bus.subscribe((event) => {
      received[0]?.push(event.id);
      if (event.id === 1) {
        // Reentrant publish while id 1 is being delivered: must NOT reach
        // subscribers before the rest of the committed batch (id 2).
        bus.publish('agent.status_changed', { name: 'dev', status: 'nested' }); // id 3
      }
    });
    bus.subscribe((event) => received[1]?.push(event.id));

    bus.transaction((persist) => {
      persist('message.created', wire(1)); // id 1
      persist('message.created', wire(2)); // id 2
      return null;
    });

    // Every subscriber sees the batch atomically: 1, 2 before the reentrant 3
    // (1, 3, 2 would let an SSE cursor advance past 2 and drop it).
    expect(received[0]).toEqual([1, 2, 3]);
    expect(received[1]).toEqual([1, 2, 3]);
  });

  it('async transaction callbacks are rejected and fully rolled back (no phantom, no store-without-fanout)', async () => {
    const { bus, sqlite } = freshBus(tempDir());
    const seen: BusEvent[] = [];
    bus.subscribe((event) => seen.push(event));

    let lateError: Error | undefined;
    const attempted = async (): Promise<unknown> =>
      bus.transaction(async (persist) => {
        persist('message.created', wire(1)); // sync prefix — better-sqlite3 rolls this back
        await Promise.resolve(); // continuation runs after the transaction attempt failed
        try {
          persist('message.created', wire(2)); // dead handle
        } catch (err) {
          lateError = err as Error;
        }
        return 'ignored';
      });

    // better-sqlite3 refuses promise-returning transaction functions (rollback);
    // the bus contract states sync-only and keeps a redundant runtime guard.
    await expect(attempted()).rejects.toThrow(/synchronous|promise/i);
    // Rollback: no emission, nothing stored or replayable.
    expect(seen).toEqual([]);
    expect(bus.replay(0)).toEqual([]);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM events').get()).toEqual({ n: 0 });
    // The continuation's persist call hit the dead handle: rejected, nothing stored.
    expect(lateError).toBeInstanceOf(Error);
    expect(lateError?.message).toMatch(/persist handle used outside/);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM messages').get()).toEqual({ n: 0 });
  });

  it('reentrant publish during fan-out cannot reorder delivery (n before n+1 to every subscriber)', () => {
    const { bus } = freshBus(tempDir());
    const received: string[] = [];
    let publishedNested = false;
    const unsubscribeFirst = bus.subscribe((event) => {
      received.push(`A:${event.id}`);
      if (!publishedNested) {
        publishedNested = true;
        bus.publish('agent.status_changed', { name: 'dev', status: 'nested' }); // id 2, reentrant
      }
    });
    bus.subscribe((event) => received.push(`B:${event.id}`));
    bus.publish('message.created', wire(1)); // id 1

    // With unserialized fan-out, A's reentrant publish would deliver id 2 to B
    // before B ever saw id 1. Serialized delivery forbids that.
    expect(received).toEqual(['A:1', 'B:1', 'A:2', 'B:2']);
    unsubscribeFirst();
  });
});
