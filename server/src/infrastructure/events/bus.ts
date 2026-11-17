// Internal event bus (infrastructure/events). Publish = persist to the shared
// `events` table + fan out to in-process subscribers. Both happen in the same
// synchronous step; ids come from the table's single AUTOINCREMENT sequence
// (shared across ALL event types), which is the one `Last-Event-ID` cursor
// (assessment §7). Single-process ordering by rowid is guaranteed because
// better-sqlite3 writes are synchronous — a message ingest (Phase 4) that
// publishes inside its transaction cannot interleave event rows.
//
// No Fastify, no drizzle: takes the raw better-sqlite3 handle only, so domain
// modules can depend on this without the HTTP layer.
import type Database from 'better-sqlite3';
import { eventPayloadSchemas } from '../../shared/schemas/events.js';
import type { LobbyEventMap, EventType } from '../../shared/types/events.js';

export type BusEventType = EventType;

export interface BusEvent<K extends BusEventType = BusEventType> {
  readonly id: number;
  readonly type: K;
  readonly payload: LobbyEventMap[K];
  readonly ts: string;
}

export type EventSubscriber = (event: BusEvent) => void | Promise<void>;

const REPLAY_SQL = 'SELECT id, type, payload, ts FROM events WHERE id > ? ORDER BY id ASC';

export class EventBus {
  readonly #db: Database.Database;
  readonly #insert: Database.Statement;
  readonly #subscribers = new Set<EventSubscriber>();  /**
   * Identity token of the currently-executing transaction() callback. Each
   * transaction gets a UNIQUE token and its injected `persist` handle closes
   * over it, so a handle can never be confused with another (earlier or
   * later) transaction's handle — a stale handle is rejected in every state:
   * no active callback, another callback active, or after its own callback
   * returned.
   */
  #activeTxToken: symbol | undefined;
  /** True while a fan-out unit is being delivered (reentrancy serialization). */
  #delivering = false;
  /**
   * Reentrant fan-out units (each unit = one atomic, id-ordered batch),
   * drained strictly FIFO after the current unit completes.
   */
  readonly #pendingUnits: BusEvent[][] = [];

  constructor(db: Database.Database) {
    this.#db = db;
    this.#insert = db.prepare('INSERT INTO events (type, payload, ts) VALUES (?, ?, ?)');
  }

  subscribe(subscriber: EventSubscriber): () => void {
    this.#subscribers.add(subscriber);
    return () => {
      this.#subscribers.delete(subscriber);
    };
  }

  /**
   * Contract (structural, not convention): every path to fan-out runs only
   * AFTER the event row is durably committed, subscribers always receive
   * events in persisted-id order, and fan-out is serialized — each event is
   * fully delivered to all subscribers before the next one starts, even when
   * a subscriber publishes reentrantly (deferred, FIFO).
   *
   * - `publish(type, payload)` — autocommit path: inserts (its own implicit
   *   transaction, synchronous) and fans out immediately after that commit.
   *   Throws if the bus connection is inside a transaction — use `transaction()`.
   * - `transaction(fn)` — atomic path: events persisted via the injected
   *   `persist` join the caller's transaction; fan-out happens exactly once
   *   per event, only after commit, in persisted-id order. The committed
   *   batch is fanned out as ONE ATOMIC UNIT: all of its events reach every
   *   subscriber before any later unit (e.g. a subscriber's reentrant
   *   publish) is delivered, so no event of the batch can be overtaken and
   *   dropped by an SSE cursor. On rollback nothing is emitted and nothing
   *   is left for `replay()`. `fn` MUST be synchronous (rejected at runtime
   *   otherwise) and the `persist` handle is bound to THIS transaction
   *   instance — it is invalidated the moment the callback returns and is
   *   rejected during any other transaction, so no event can be stored
   *   without its fan-out.
   *
   * Phase 4 constraint: inside `transaction()` only synchronous SQLite work is
   * possible (single connection, sync transaction). Upstream/async work must
   * happen before opening the transaction.
   */
  publish<K extends BusEventType>(type: K, payload: LobbyEventMap[K]): BusEvent<K> {
    if (this.#db.inTransaction) {
      throw new Error(
        'EventBus.publish must not be called inside an open transaction (would notify before commit); use EventBus.transaction()',
      );
    }
    const event = this.#persist(type, payload);
    this.#fanOutUnit([event]); // insert above already committed (autocommit)
    return event;
  }

  /**
   * Run `fn` in a transaction on the bus connection and emit the events it
   * persisted — exactly once, after commit, in persisted-id order. The same
   * connection runs the caller's other writes, so event rows and message
   * rows commit or roll back together. Nested bus transactions are rejected.
   * Async callbacks are rejected (see the class contract).
   */
  transaction<T>(fn: (persist: <K extends BusEventType>(type: K, payload: LobbyEventMap[K]) => BusEvent<K>) => T): T {
    if (this.#db.inTransaction) {
      throw new Error('EventBus.transaction cannot nest (bus connection is already in a transaction)');
    }
    const queue: BusEvent[] = [];
    // Each handle is bound to ITS OWN transaction instance: only a call while
    // THIS token is active is accepted. A retained handle from an earlier
    // transaction called during a later one (or with none active) is rejected
    // BEFORE any insert — it would otherwise commit in the later transaction
    // and append to the earlier one's dead queue (no fan-out).
    const token = Symbol('EventBus.transaction');
    const persist = <K extends BusEventType>(type: K, payload: LobbyEventMap[K]): BusEvent<K> => {
      if (this.#activeTxToken !== token) {
        throw new Error('EventBus: persist handle used outside its transaction callback (rejected — event would be stored without fan-out)');
      }
      const event = this.#persist(type, payload);
      queue.push(event);
      return event;
    };
    this.#activeTxToken = token;
    let result: T;
    try {
      // Rolls back and rethrows on error — in that case queue is discarded and
      // nothing below runs: no emission for a rolled-back transaction.
      result = this.#db.transaction(() => fn(persist))();
      if (result instanceof Promise) {
        // Sync-prefix events of an async callback are already committed AND
        // emitted at this point (consistent state); the async usage itself is
        // rejected so no continuation can store-without-fan-out (the handle is
        // also dead now).
        throw new Error('EventBus.transaction callback must be synchronous (SQLite transactions are synchronous; async work must happen outside)');
      }
    } finally {
      this.#activeTxToken = undefined; // the handle dies with its callback
    }
    this.#fanOutUnit(queue); // after commit; the whole batch is one atomic unit
    return result;
  }

  /** Validate + insert one event row on the bus connection (private). */
  #persist<K extends BusEventType>(type: K, payload: LobbyEventMap[K]): BusEvent<K> {
    const data = eventPayloadSchemas[type].parse(payload) as LobbyEventMap[K];
    const ts = new Date().toISOString();
    const id = Number(this.#insert.run(type, JSON.stringify(data), ts).lastInsertRowid);
    return { id, type, payload: data, ts };
  }

  /**
   * Latest persisted event id (0 when no events exist yet). The SSE endpoint
   * uses it as the LIVE HEAD for fresh connections (no Last-Event-ID): they
   * start here — no history replay — and receive only events published after
   * this point (assessment §7: catch-up is reconnect semantics).
   */
  head(): number {
    const row = this.#db.prepare('SELECT MAX(id) AS head FROM events').get() as {
      head: number | null;
    };
    return row.head ?? 0;
  }

  /**
   * Persisted events with id > afterId, in id order (SSE Last-Event-ID catch-up).
   * Unknown or corrupt rows are skipped (forward-compatible, never fatal).
   */
  replay(afterId: number): BusEvent[] {
    const rows = this.#db.prepare(REPLAY_SQL).all(afterId) as Array<{
      id: number;
      type: string;
      payload: string;
      ts: string;
    }>;
    const out: BusEvent[] = [];
    for (const row of rows) {
      // Object.hasOwn, not `in`: `in` accepts INHERITED names ('toString'),
      // which would resolve to a non-schema value and throw below instead of
      // skipping (unknown types are skipped by design, never fatal).
      const schema = Object.hasOwn(eventPayloadSchemas, row.type)
        ? eventPayloadSchemas[row.type as BusEventType]
        : undefined;
      if (schema === undefined) continue;
      let data: unknown;
      try {
        data = JSON.parse(row.payload);
      } catch (err) {
        console.error(`[events] skipping event row ${row.id} with unparseable payload`, err);
        continue;
      }
      const parsed = schema.safeParse(data);
      if (!parsed.success) {
        console.error(`[events] skipping corrupt event row ${row.id} (${row.type})`, parsed.error);
        continue;
      }
      out.push({ id: Number(row.id), type: row.type as BusEventType, payload: parsed.data, ts: row.ts });
    }
    return out;
  }

  close(): void {
    this.#subscribers.clear();
  }

  /**
   * Serialized fan-out of ATOMIC units. A unit is one id-ordered batch
   * (a single `publish()` event, or a committed `transaction()`'s whole
   * batch). Units are delivered strictly FIFO and never interleaved: all of
   * a unit's events reach every subscriber before any later unit starts, so
   * a reentrant publish (the synchronous prefix of any subscriber, including
   * an async subscriber's pre-await code) cannot overtake the rest of a
   * transaction batch — it is enqueued as a LATER unit. Id order is
   * preserved across units: a unit's events were all persisted before its
   * fan-out started, so any event persisted while it is delivering has a
   * strictly higher id and sits in a later unit.
   */
  #fanOutUnit(unit: readonly BusEvent[]): void {
    if (this.#delivering) {
      this.#pendingUnits.push([...unit]);
      return;
    }
    this.#delivering = true;
    try {
      this.#deliverBatch(unit);
      for (let next = this.#pendingUnits.shift(); next !== undefined; next = this.#pendingUnits.shift()) {
        this.#deliverBatch(next);
      }
    } finally {
      this.#delivering = false;
    }
  }

  #deliverBatch(events: readonly BusEvent[]): void {
    for (const event of events) this.#deliver(event);
  }

  #deliver(event: BusEvent): void {
    for (const subscriber of [...this.#subscribers]) {
      try {
        const result = subscriber(event);
        if (result instanceof Promise) {
          // Async subscriber failures must not break publish or other subscribers.
          result.catch((err: unknown) => console.error('[events] subscriber failed', err));
        }
      } catch (err) {
        console.error('[events] subscriber failed', err);
      }
    }
  }
}
