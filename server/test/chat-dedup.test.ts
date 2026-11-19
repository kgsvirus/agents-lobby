// Chat message repository — insert-dedup guard (work order Task 1.2, review
// round 2): a duplicate capture of the SAME OpenCode event (same sender +
// null-safe receiver + body within a small ts window) must be SKIPPED +
// logged, never stored. The guard is restricted to EVENT CAPTURES (the
// OpenCode-listener path): explicit /send fan-out rows and legacy /webhook
// rows are deliberate inserts and are NEVER deduped (review fix 3) — history
// must agree with the prompts actually delivered. Live evidence: canonical
// rows 1461/1462 and 1463/1464 were 1–4 ms apart duplicates while two server
// instances ran on the same db — so the guard lives at the db-level insert
// boundary and must hold ACROSS connections; the ingest transaction takes the
// write lock at BEGIN (EventBus BEGIN IMMEDIATE + busy_timeout) so the
// second instance cannot interleave its check (review fix 4). Temp dbs only
// — never a live db.
import Database from 'better-sqlite3';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { describe, expect, it, vi } from 'vitest';
import { openDatabase, runMigrations, migrationsFolder } from '../src/infrastructure/database/client.js';
import { EventBus } from '../src/infrastructure/events/bus.js';
import { ChatMessageRepository } from '../src/modules/chat/infrastructure/message-repository.js';
import { ChatService } from '../src/modules/chat/application/chat-service.js';
import type { ChatMessageStore } from '../src/modules/chat/application/ports.js';
import { exampleRegistry, fakeOpenCode, fakeRegistry } from './chat-fakes.js';
import { tempDir } from './helpers.js';

/** Two independent handles over ONE db file — the dual-instance model. */
function openSharedDb(
  name: string,
  secondOptions: Parameters<typeof openDatabase>[1] = {},
): { repos: ChatMessageRepository[]; close(): void } {
  const dbPath = join(tempDir(), name);
  const repos: ChatMessageRepository[] = [];
  const handles: Array<{ close(): void }> = [];
  for (let i = 0; i < 2; i++) {
    const { db, sqlite } = openDatabase(dbPath, i === 1 ? secondOptions : undefined);
    runMigrations(db, migrationsFolder());
    repos.push(new ChatMessageRepository(sqlite));
    handles.push({ close: () => void sqlite.close() });
  }
  return { repos, close: () => handles.forEach((h) => h.close()) };
}

const iso = (offsetMs = 0): string => new Date(Date.now() + offsetMs).toISOString();

describe('insert-dedup guard (event captures only, repository insert boundary)', () => {
  it('a duplicate CAPTURE insert (same sender + receiver + body, ts within the capture-skew window) is skipped + logged; the original row is untouched', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { repos, close } = openSharedDb('dedup-skip.db');
    try {
      const [repo] = repos;
      const original = repo.insert({ ts: iso(), from: 'greg', to: 'boss', body: 'same text', sessionId: 'ses_x' }, true);
      expect(original.inserted).toBe(true); // the repository reports WHICH outcome happened
      const attempted = repo.insert({ ts: iso(4), from: 'greg', to: 'boss', body: 'same text', sessionId: 'ses_x' }, true);
      // Skip: no new row — the ORIGINAL row is returned, untouched (same id/fields).
      expect(attempted.inserted).toBe(false);
      expect(attempted.row).toEqual(original.row);
      const rows = repo.query({ view: 'all', after: 0, before: 0, limit: 100, agents: [] }).rows;
      expect(rows).toEqual([{ ...original.row }]);
      expect(warnSpy).toHaveBeenCalledTimes(1);
    } finally {
      warnSpy.mockRestore();
      close();
    }
  });

  it('holds across TWO connections over the same db (the dual-instance failure): the second instance’s duplicate is skipped', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { repos, close } = openSharedDb('dedup-dual.db');
    try {
      const [instanceA, instanceB] = repos;
      const original = instanceA.insert({ ts: iso(), from: 'porty', to: null, body: 'webhook echo', sessionId: null }, true);
      const attempted = instanceB.insert({ ts: iso(4), from: 'porty', to: null, body: 'webhook echo', sessionId: null }, true);
      expect(attempted.inserted).toBe(false); // skipped: instance B saw instance A's row
      expect(attempted.row).toEqual(original.row);
      const rows = instanceA.query({ view: 'all', after: 0, before: 0, limit: 100, agents: [] }).rows;
      expect(rows).toHaveLength(1); // no duplicate row stored (the rows 1461/1462 class)
      expect(warnSpy).toHaveBeenCalledTimes(1);
    } finally {
      warnSpy.mockRestore();
      close();
    }
  });

  it('two DELIBERATE identical messages seconds apart are BOTH stored: the window covers capture skew (the live duplicates were 1-4 ms apart), not a 5 s rerun of the same text', () => {
    const { repos, close } = openSharedDb('dedup-window.db');
    try {
      const [repo] = repos;
      // The finding's case: a user sends "yes" twice. 2 s apart sits INSIDE
      // the old 5 s window (the second real message was swallowed) and far
      // outside the capture-skew window the guard actually needs.
      const first = repo.insert({ ts: iso(-12_000), from: 'human', to: 'boss', body: 'yes', sessionId: 'ses_boss' }, true).row;
      const second = repo.insert({ ts: iso(-2_000), from: 'human', to: 'boss', body: 'yes', sessionId: 'ses_boss' }, true);
      const third = repo.insert({ ts: iso(), from: 'human', to: 'boss', body: 'yes', sessionId: 'ses_boss' }, true);
      expect(second.inserted).toBe(true);
      expect(third.inserted).toBe(true);
      expect(second.row.id).toBe(first.id + 1);
      // Both deliberate repeats — and every later one — are stored.
      expect(repo.query({ view: 'all', after: 0, before: 0, limit: 100, agents: [] }).rows).toHaveLength(3);
    } finally {
      close();
    }
  });

  it('a different body within the window still inserts', () => {
    const { repos, close } = openSharedDb('dedup-body.db');
    try {
      const [repo] = repos;
      repo.insert({ ts: iso(), from: 'greg', to: 'boss', body: 'first', sessionId: null }, true);
      repo.insert({ ts: iso(1), from: 'greg', to: 'boss', body: 'second', sessionId: null }, true);
      expect(repo.query({ view: 'all', after: 0, before: 0, limit: 100, agents: [] }).rows).toHaveLength(2);
    } finally {
      close();
    }
  });

  it('receiver participates in the match: a different receiver still inserts, and NULL matches NULL (null-safe IS)', () => {
    const { repos, close } = openSharedDb('dedup-receiver.db');
    try {
      const [repo] = repos;
      repo.insert({ ts: iso(), from: 'greg', to: null, body: 'same text', sessionId: null }, true);
      // NULL receiver ≠ a value receiver → inserts.
      repo.insert({ ts: iso(1), from: 'greg', to: 'boss', body: 'same text', sessionId: null }, true);
      // NULL receiver IS NULL → the duplicate (webhook-shaped) is skipped.
      repo.insert({ ts: iso(2), from: 'greg', to: null, body: 'same text', sessionId: 'ses_z' }, true);
      expect(repo.query({ view: 'all', after: 0, before: 0, limit: 100, agents: [] }).rows).toHaveLength(2);
    } finally {
      close();
    }
  });

  it('explicit /send inserts are NEVER deduped: two identical sends within the window both store (review fix 3)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fakes = await import('./chat-fakes.js');
    const f = fakes.makeChatFixture(fakes.fakeRegistry(fakes.exampleRegistry()));
    try {
      await f.service.sendMessage({ to: 'taskflow', message: 'same text', from: 'boss' });
      await f.service.sendMessage({ to: 'taskflow', message: 'same text', from: 'boss' });
      // Prompted twice → history must show both rows (bridge /send semantics).
      expect(f.opencode.promptCalls).toHaveLength(2);
      const rows = f.store.query({ view: 'all', after: 0, before: 0, limit: 100, agents: [] }).rows;
      expect(rows.map((r) => [r.from, r.to, r.text])).toEqual([
        ['boss', 'taskflow', 'same text'],
        ['boss', 'taskflow', 'same text'],
      ]);
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('legacy /webhook inserts are NEVER deduped (not the OpenCode-listener path; bridge stored every POST)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fakes = await import('./chat-fakes.js');
    const f = fakes.makeChatFixture(fakes.fakeRegistry(fakes.exampleRegistry()));
    try {
      await f.service.webhookMessage({ from: 'greg', message: 'retry' });
      await f.service.webhookMessage({ from: 'greg', message: 'retry' });
      const rows = f.store.query({ view: 'all', after: 0, before: 0, limit: 100, agents: [] }).rows;
      expect(rows.map((r) => [r.from, r.text])).toEqual([['greg', 'retry'], ['greg', 'retry']]);
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('a duplicate capture through ChatService.handleEvent (same event twice) stores one row', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fakes = await import('./chat-fakes.js');
    const f = fakes.makeChatFixture(fakes.fakeRegistry(fakes.exampleRegistry()));
    try {
      const event = {
        kind: 'inbox' as const, from: 'human', to: 'boss', body: 'hello boss',
        sessionId: 'ses_boss', ts: new Date().toISOString(),
      };
      await f.service.handleEvent(event);
      await f.service.handleEvent({ ...event }); // the same OpenCode event redelivered
      const rows = f.store.query({ view: 'all', after: 0, before: 0, limit: 100, agents: [] }).rows;
      expect(rows).toHaveLength(1);
      expect(warnSpy).toHaveBeenCalledTimes(1);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('a skipped duplicate capture publishes NO message.created event (the log must not report a creation that did not happen)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fakes = await import('./chat-fakes.js');
    const f = fakes.makeChatFixture(fakes.fakeRegistry(fakes.exampleRegistry()));
    try {
      const published: string[] = [];
      f.bus.subscribe((e) => published.push(e.type));
      const event = {
        kind: 'inbox' as const, from: 'human', to: 'boss', body: 'only once',
        sessionId: 'ses_boss', ts: new Date().toISOString(),
      };
      await f.service.handleEvent(event);
      await f.service.handleEvent({ ...event }); // the same OpenCode event redelivered
      // One row AND one event: the redelivery did not create anything, so it
      // must not announce a creation to subscribers/SSE either.
      expect(f.store.query({ view: 'all', after: 0, before: 0, limit: 100, agents: [] }).rows).toHaveLength(1);
      expect(published).toEqual(['message.created']);
      expect(warnSpy).toHaveBeenCalledTimes(1);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('two DELIBERATE identical captures seconds apart publish TWO message.created events (the second real message is not dropped)', async () => {
    const fakes = await import('./chat-fakes.js');
    const f = fakes.makeChatFixture(fakes.fakeRegistry(fakes.exampleRegistry()));
    const published: string[] = [];
    f.bus.subscribe((e) => published.push(e.type));
    const base = { kind: 'inbox' as const, from: 'human', to: 'boss', body: 'yes', sessionId: 'ses_boss' };
    await f.service.handleEvent({ ...base, ts: new Date(Date.now() - 2_000).toISOString() });
    await f.service.handleEvent({ ...base, ts: new Date().toISOString() });
    expect(f.store.query({ view: 'all', after: 0, before: 0, limit: 100, agents: [] }).rows).toHaveLength(2);
    expect(published).toEqual(['message.created', 'message.created']);
  });


  it('the ingest transaction takes the write lock at BEGIN (BEGIN IMMEDIATE): a concurrent connection cannot interleave its dedup check, and after the winner commits the loser sees the duplicate (review fix 4)', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const file = join(tempDir(), 'dedup-atomic.db');
    const a = openDatabase(file);
    runMigrations(a.db, migrationsFolder());
    // Second instance with a fast-fail busy_timeout (production waits on the
    // explicit 5s busy_timeout; the 10ms override keeps the test instant).
    const b = openDatabase(file, { timeout: 10 });
    runMigrations(b.db, migrationsFolder());
    const busA = new EventBus(a.sqlite);
    const repoA = new ChatMessageRepository(a.sqlite);
    const repoB = new ChatMessageRepository(b.sqlite);
    const row = { ts: iso(), from: 'greg', to: 'boss', body: 'same text', sessionId: null };
    let original!: ReturnType<ChatMessageRepository['insert']>['row'];
    busA.transaction(() => {
      // Instance A's ingest is open and PRE-WRITE — exactly the dedup check's
      // position. A concurrent connection must NOT be able to BEGIN its own
      // write transaction here: with BEGIN IMMEDIATE the write lock is held
      // from BEGIN, so B's attempt hits SQLITE_BUSY (with the production
      // busy_timeout it WAITS instead of failing fast, then sees the committed
      // duplicate). A deferred begin would let B interleave its check.
      let busyCode: string | undefined;
      try {
        new EventBus(b.sqlite).transaction(() => {});
      } catch (err) {
        busyCode = (err as { code?: string }).code;
      }
      expect(busyCode).toBe('SQLITE_BUSY');
      original = repoA.insert({ ...row }).row;
    });
    // A committed. B now evaluates its check (the post-wait state) and skips:
    const attempted = repoB.insert({ ...row, ts: iso(1) }, true);
    expect(attempted.inserted).toBe(false);
    expect(attempted.row).toEqual(original);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(repoA.query({ view: 'all', after: 0, before: 0, limit: 100, agents: [] }).rows).toHaveLength(1);
    warnSpy.mockRestore();
  });

  // --- Contended-ingest through the REAL transaction path (review round 3) ---

  /** The lock-holder runs on a SEPARATE THREAD (the synchronous SQLite driver
   *  cannot contend with itself in-process): it opens its own connection,
   *  takes BEGIN IMMEDIATE, optionally inserts a row inside the lock, and
   *  commits on its own timeline while the main thread's ingest waits. */
  const LOCK_WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
const Database = require(workerData.betterSqlite3Path);
const db = new Database(workerData.file, { timeout: 5000 });
db.exec('BEGIN IMMEDIATE');
if (workerData.row) {
  db.prepare('INSERT INTO messages (ts, sender, receiver, body, session_id) VALUES (?, ?, ?, ?, ?)')
    .run(workerData.row.ts, workerData.row.from, workerData.row.to, workerData.row.body, workerData.row.sessionId);
}
parentPort.postMessage('locked');
setTimeout(() => {
  db.exec('COMMIT');
  db.close();
  parentPort.postMessage('released');
}, workerData.holdMs);
`;

  interface LockRow {
    readonly ts: string;
    readonly from: string;
    readonly to: string | null;
    readonly body: string;
    readonly sessionId: string | null;
  }

  function spawnLockWorker(file: string, opts: { holdMs: number; row?: LockRow }): Worker {
    // A .cjs script file: CommonJS regardless of the package's "type": "module".
    // The temp dir has no node_modules — pass the resolved native module path.
    const scriptPath = join(tempDir(), 'lock-holder.cjs');
    writeFileSync(scriptPath, LOCK_WORKER_SOURCE, 'utf8');
    return new Worker(scriptPath, {
      workerData: {
        file,
        betterSqlite3Path: createRequire(import.meta.url).resolve('better-sqlite3'),
        ...opts,
      },
    });
  }

  function waitForWorkerMessage(worker: Worker, text: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const onMessage = (value: unknown): void => {
        if (value === text) {
          worker.off('message', onMessage);
          resolve();
        }
      };
      worker.once('error', reject);
      worker.on('message', onMessage);
    });
  }

  /** The REAL ingest stack (bus + repository + ChatService) over a given db
   *  handle — the same composition the composition root and chat-fakes use.
   *  `bus` lets a test wrap the real bus (counted / error-injecting proxy). */
  function buildIngestService(
    handle: ReturnType<typeof openDatabase>,
    opts: { busyRetryBudgetMs?: number; bus?: { transaction: EventBus['transaction'] } } = {},
  ): ChatService {
    const oc = fakeOpenCode();
    return new ChatService({
      store: new ChatMessageRepository(handle.sqlite),
      registry: fakeRegistry(exampleRegistry()),
      ports: {
        prompts: oc.integration.prompts,
        sessions: oc.integration.sessions,
        bus: opts.bus ?? new EventBus(handle.sqlite),
      },
      busyRetryBudgetMs: opts.busyRetryBudgetMs,
    });
  }

  /** A bus proxy that counts transaction() invocations — observable evidence
   *  that the busy-retry loop genuinely re-entered the transaction. */
  function countedBus(real: EventBus): { bus: { transaction: EventBus['transaction'] }; count(): number } {
    let invocations = 0;
    return {
      bus: {
        transaction: (fn) => {
          invocations += 1;
          return real.transaction(fn);
        },
      },
      count: () => invocations,
    };
  }

  /** A bus proxy that records, at EVERY transaction attempt, the CONNECTION's
   *  current busy_timeout and the wall-clock start — observable evidence that
   *  the per-attempt cap is in effect DURING retries (review round 5), and of
   *  exactly which attempts were launched (no attempt past the deadline). */
  function observingBus(
    real: EventBus,
    sqlite: Database.Database,
  ): {
    bus: { transaction: EventBus['transaction'] };
    timeouts: number[];
    starts: number[];
  } {
    const timeouts: number[] = [];
    const starts: number[] = [];
    return {
      bus: {
        transaction: (fn) => {
          timeouts.push(sqlite.pragma('busy_timeout', { simple: true }) as number);
          starts.push(Date.now());
          return real.transaction(fn);
        },
      },
      timeouts,
      starts,
    };
  }

  const readRows = (repo: ChatMessageRepository) =>
    repo.query({ view: 'all', after: 0, before: 0, limit: 100, agents: [] }).rows;

  it('a contended ingest through the REAL listener path waits for the lock and inserts once it frees (A commits mid-wait, no row loss)', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const file = join(tempDir(), 'dedup-contend-new.db');
    const a = openDatabase(file);
    runMigrations(a.db, migrationsFolder());
    // B's driver busy timeout (300ms) is SHORTER than the worker's hold
    // (1.2s): the driver wait alone cannot absorb the contention — the FIRST
    // attempt throws SQLITE_BUSY and the RETRY LOOP must carry B across the
    // release. The counted bus proves the retry genuinely engaged.
    const b = openDatabase(file, { timeout: 300 });
    runMigrations(b.db, migrationsFolder());
    const counted = countedBus(new EventBus(b.sqlite));
    const serviceB = buildIngestService(b, { bus: counted.bus });
    const worker = spawnLockWorker(file, { holdMs: 1_200 }); // holds BEGIN IMMEDIATE, inserts NOTHING, commits mid-wait
    try {
      await waitForWorkerMessage(worker, 'locked');
      // Register the release waiter BEFORE the ingest: yielding retries let
      // the worker's message be processed before a later listener attaches.
      const released = waitForWorkerMessage(worker, 'released');
      const started = Date.now();
      // The ACTUAL listener ingest entry — not a no-op transaction, not a
      // post-hoc direct repo call:
      await serviceB.handleEvent({
        kind: 'inbox', from: 'human', to: 'boss', body: 'contended new', sessionId: 'ses_boss', ts: iso(),
      });
      expect(Date.now() - started).toBeGreaterThanOrEqual(900); // the wait was real
      expect(counted.count()).toBeGreaterThanOrEqual(2); // the retry loop ran (first attempt hit the driver timeout)
      expect(readRows(new ChatMessageRepository(b.sqlite)).map((r) => r.text)).toEqual(['contended new']);
      expect(warnSpy).not.toHaveBeenCalled(); // not a duplicate — a fresh insert
      expect(errSpy).not.toHaveBeenCalled(); // no error-swallow: no loss
      await released;
    } finally {
      await worker.terminate();
      errSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  it('busy retries YIELD the event loop: timers keep firing while a contended ingest retries (no synchronous park of the whole server)', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const file = join(tempDir(), 'dedup-yield.db');
    const a = openDatabase(file);
    runMigrations(a.db, migrationsFolder());
    const b = openDatabase(file, { timeout: 300 });
    runMigrations(b.db, migrationsFolder());
    const serviceB = buildIngestService(b);
    const worker = spawnLockWorker(file, { holdMs: 1_200 });
    try {
      await waitForWorkerMessage(worker, 'locked');
      const released = waitForWorkerMessage(worker, 'released'); // registered before the ingest (see the insert test)
      const ticks: number[] = [];
      const timer = setInterval(() => ticks.push(Date.now()), 20);
      try {
        await serviceB.handleEvent({
          kind: 'inbox', from: 'human', to: 'boss', body: 'yielding retry', sessionId: 'ses_boss', ts: iso(),
        });
      } finally {
        clearInterval(timer);
      }
      // A synchronous nap (Atomics.wait) parks the whole thread: with the old
      // implementation ZERO timer callbacks run during the contention. Yielding
      // retries let the interval fire at every nap (typically 4-8 ticks for the
      // ~1.4 s ingest; >= 3 is the "timers really ran" floor).
      // Known flake under parallel load: this asserts a wall-clock floor. Fix by
      // removing the time dependency (fake clock or deterministic tick
      // accounting), never by lowering the floor - the behaviour it guards is
      // an async yield, not a tick count.
      expect(ticks.length).toBeGreaterThanOrEqual(3);
      expect(readRows(new ChatMessageRepository(b.sqlite)).map((r) => r.text)).toEqual(['yielding retry']);
      expect(errSpy).not.toHaveBeenCalled(); // no CAPTURE LOST
      await released;
    } finally {
      await worker.terminate();
      errSpy.mockRestore();
    }
  });

  it('a contended ingest whose duplicate was committed while the lock was held retries, then SKIPS (dedup-skip, not busy-failure)', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const file = join(tempDir(), 'dedup-contend-dup.db');
    const a = openDatabase(file);
    runMigrations(a.db, migrationsFolder());
    // Same short-driver setup as the insert-if-new test: the driver wait
    // cannot absorb the hold, so the RETRY LOOP runs — and on a post-release
    // attempt the dedup RE-CHECK sees the duplicate committed during the wait
    // → skip, not a second row.
    const b = openDatabase(file, { timeout: 300 });
    runMigrations(b.db, migrationsFolder());
    const counted = countedBus(new EventBus(b.sqlite));
    const serviceB = buildIngestService(b, { bus: counted.bus });
    // The worker's row is EXACTLY what B's listener capture will look like
    // (sender 'human' → receiver 'boss') — the dedup key is sender + receiver
    // + body, so the identity must match for the skip to trigger:
    const row: LockRow = { ts: iso(), from: 'human', to: 'boss', body: 'contended dup', sessionId: null };
    const worker = spawnLockWorker(file, { holdMs: 1_200, row }); // holds the lock AND inserts the duplicate, commits mid-wait
    try {
      await waitForWorkerMessage(worker, 'locked');
      const released = waitForWorkerMessage(worker, 'released'); // registered before the ingest (see the insert test)
      const started = Date.now();
      await serviceB.handleEvent({
        kind: 'inbox', from: 'human', to: 'boss', body: row.body, sessionId: 'ses_boss', ts: row.ts,
      });
      expect(Date.now() - started).toBeGreaterThanOrEqual(900); // the wait was real
      expect(counted.count()).toBeGreaterThanOrEqual(2); // the retry loop ran
      expect(readRows(new ChatMessageRepository(b.sqlite)).map((r) => r.text)).toEqual([row.body]); // exactly one row (A's)
      expect(warnSpy).toHaveBeenCalledTimes(1); // the skip is logged
      expect(errSpy).not.toHaveBeenCalled(); // no error-swallow
      await released;
    } finally {
      await worker.terminate();
      errSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  it('an EXTENDED busy code (SQLITE_BUSY*) engages the retry instead of failing fast (the driver maps extended codes: constants.cpp 101-102)', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const handle = openDatabase(join(tempDir(), 'dedup-extended.db'));
    runMigrations(handle.db, migrationsFolder());
    // The driver's ACTUAL error shape: a real better-sqlite3 SqliteError with
    // an extended busy code (better-sqlite3 surfaces extended codes — its
    // constants table maps SQLITE_BUSY_RECOVERY / SQLITE_BUSY_SNAPSHOT).
    const realBus = new EventBus(handle.sqlite);
    let invocations = 0;
    const bus = {
      transaction: (fn: Parameters<EventBus['transaction']>[0]) => {
        invocations += 1;
        if (invocations === 1) {
          throw new Database.SqliteError('busy snapshot', 'SQLITE_BUSY_SNAPSHOT');
        }
        return realBus.transaction(fn);
      },
    };
    const serviceB = buildIngestService(handle, { bus });
    try {
      await serviceB.handleEvent({
        kind: 'inbox', from: 'human', to: 'boss', body: 'extended busy', sessionId: 'ses_boss', ts: iso(),
      });
      expect(invocations).toBe(2); // the extended code was treated as busy → retried, not failed fast
      expect(readRows(new ChatMessageRepository(handle.sqlite)).map((r) => r.text)).toEqual(['extended busy']);
      expect(warnSpy).not.toHaveBeenCalled();
      expect(errSpy).not.toHaveBeenCalled(); // no CAPTURE LOST — the capture survived
    } finally {
      errSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  it('the ingest gives up only after the busy-retry budget: the last-resort CAPTURE LOST error identifies the row WITHOUT its body (never silently dropped), every attempt\'s synchronous wait is short, and the connection busy_timeout is RESTORED afterwards', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const file = join(tempDir(), 'dedup-exhaust.db');
    const a = openDatabase(file);
    runMigrations(a.db, migrationsFolder());
    // Driver wait 500ms, budget 800ms: every attempt's synchronous driver wait
    // is capped (250ms) so a contended capture cannot park the event loop for
    // most of the budget; the async nap between attempts yields it. The
    // nap-then-recheck deadline order + the cap keep the total ≈ the budget.
    // The lock is NEVER released within the budget.
    const b = openDatabase(file, { timeout: 500 });
    runMigrations(b.db, migrationsFolder());
    const observed = observingBus(new EventBus(b.sqlite), b.sqlite);
    const serviceB = buildIngestService(b, { busyRetryBudgetMs: 800, bus: observed.bus });
    const originalTimeout = b.sqlite.pragma('busy_timeout', { simple: true }) as number;
    expect(originalTimeout).toBe(500); // the configured value that must survive the capped run
    try {
      a.sqlite.exec('BEGIN IMMEDIATE'); // the lock is NEVER released within the budget
      const started = Date.now();
      const event = {
        kind: 'inbox' as const, from: 'human', to: 'boss', body: 'lost capture',
        sessionId: 'ses_boss', ts: iso(),
      };
      await expect(serviceB.handleEvent(event)).rejects.toThrow(); // thrown, not swallowed
      // Blocking ≈ the budget: every attempt's cap bounds its synchronous
      // wait, and the async response/exit between attempts yields the loop.
      expect(Date.now() - started).toBeLessThanOrEqual(1100);
      // EVERY attempt runs with a SHORT cap (never the whole 500ms driver
      // wait), so the event loop is never parked for a long stretch; the cap
      // still fires DURING the retries (attempt 1 included).
      expect(observed.timeouts.length).toBeGreaterThanOrEqual(2);
      expect(observed.timeouts.every((t) => t > 0 && t <= 250)).toBe(true);
      // RESTORED afterwards: a capped run must not leave the SHARED connection
      // with a lowered busy_timeout (the registry mirror transactions use the
      // same connection WITHOUT a retry loop).
      expect(b.sqlite.pragma('busy_timeout', { simple: true })).toBe(originalTimeout);
      const lostLog = errSpy.mock.calls
        .map((c) => String(c[0]))
        .find((m) => m.includes('CAPTURE LOST'));
      expect(lostLog).toBeDefined(); // loud last-resort log
      // Identifying metadata, REDACTED body: credentials/private data never
      // reach the logs, but a lost capture stays diagnosable.
      expect(lostLog).toContain('from=human');
      expect(lostLog).toContain('to=boss');
      expect(lostLog).toContain(`ts=${event.ts}`);
      expect(lostLog).toContain('bodyLength=12'); // "lost capture"
      expect(lostLog).not.toContain('lost capture'); // the body itself is redacted
      expect(readRows(new ChatMessageRepository(b.sqlite))).toEqual([]); // not stored — the loud loss
    } finally {
      a.sqlite.exec('ROLLBACK'); // release the lock
      errSpy.mockRestore();
    }
  });

  it('no retry attempt is launched after the deadline: the backoff nap runs FIRST, then the remaining budget is re-measured (review round 5)', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const file = join(tempDir(), 'dedup-order.db');
    const a = openDatabase(file);
    runMigrations(a.db, migrationsFolder());
    // Driver wait 200ms, budget 900ms: the backoff nap doubles (25/50/100/
    // 200/400), so attempts land closer and closer to the deadline and then a
    // longer nap crosses it. The old order checked the deadline BEFORE that
    // nap, then launched a retry on a stale remaining budget AFTER the
    // deadline (observed ~1.1s total); the corrected order (nap -> recheck ->
    // cap) exhausts instead of attempting.
    const b = openDatabase(file, { timeout: 200 });
    runMigrations(b.db, migrationsFolder());
    const observed = observingBus(new EventBus(b.sqlite), b.sqlite);
    const serviceB = buildIngestService(b, { busyRetryBudgetMs: 900, bus: observed.bus });
    try {
      a.sqlite.exec('BEGIN IMMEDIATE'); // the lock is NEVER released within the budget
      const started = Date.now();
      await expect(
        serviceB.handleEvent({
          kind: 'inbox', from: 'human', to: 'boss', body: 'deadline order', sessionId: 'ses_boss', ts: iso(),
        }),
      ).rejects.toThrow(); // exhaustion, not an attempt launched past the deadline
      expect(observed.starts.length).toBeGreaterThanOrEqual(2); // the retry loop genuinely ran
      // EVERY attempt started within the budget (+ a few ms for the service's
      // own entry between `started` and its deadline): a retry is never
      // launched on a cap measured before the nap.
      expect(observed.starts.every((t) => t - started <= 925)).toBe(true);
      expect(errSpy.mock.calls.some((c) => String(c[0]).includes('CAPTURE LOST'))).toBe(true);
      expect(readRows(new ChatMessageRepository(b.sqlite))).toEqual([]); // not stored — the loud loss
    } finally {
      a.sqlite.exec('ROLLBACK'); // release the lock
      errSpy.mockRestore();
    }
  });

  it('OVERLAPPING saves never capture another save’s temporary cap: every save reads the configured busy_timeout and the connection ends at it (no permanent 250 ms)', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const handle = openDatabase(join(tempDir(), 'dedup-timeout-race.db'), { timeout: 500 });
    runMigrations(handle.db, migrationsFolder());
    const configured = handle.sqlite.pragma('busy_timeout', { simple: true }) as number;
    expect(configured).toBe(500); // the value later shared-connection writes rely on
    // The real store, with its busy_timeout READS recorded: the invariant is
    // that a save always sees the CONFIGURED value — never another in-flight
    // save's temporary per-attempt cap.
    const real = new ChatMessageRepository(handle.sqlite);
    const observedTimeouts: number[] = [];
    const store: ChatMessageStore = {
      insert: (row, dedupEventCapture) => real.insert(row, dedupEventCapture),
      busyTimeout: () => {
        const value = real.busyTimeout();
        observedTimeouts.push(value);
        return value;
      },
      setBusyTimeout: (ms) => real.setBusyTimeout(ms),
      query: (params) => real.query(params),
      unread: (consumer) => real.unread(consumer),
      markSeen: (consumer, throughId) => real.markSeen(consumer, throughId),
      lastActivity: (names) => real.lastActivity(names),
    };
    // A bus that is ALWAYS busy: both saves exhaust their (short) budget, so
    // the interleaving lives entirely in the retry loop — exactly where the
    // read-cap-restore race was.
    let attempts = 0;
    const busyBus = {
      transaction: (): never => {
        attempts += 1;
        throw new Database.SqliteError('database is locked', 'SQLITE_BUSY');
      },
    };
    const oc = fakeOpenCode();
    const service = new ChatService({
      store,
      registry: fakeRegistry(exampleRegistry()),
      ports: { prompts: oc.integration.prompts, sessions: oc.integration.sessions, bus: busyBus },
      busyRetryBudgetMs: 150,
    });
    try {
      const event = (body: string) => ({
        kind: 'inbox' as const, from: 'human', to: 'boss', body,
        sessionId: 'ses_boss', ts: new Date().toISOString(),
      });
      const a = service.handleEvent(event('race a')).catch(() => {}); // rejects on exhaustion
      // Start B only once A is INSIDE its retry loop (its second attempt ⇒ a
      // per-attempt cap is applied): B must not observe that cap as "original".
      for (let i = 0; i < 200 && attempts < 2; i++) await new Promise((r) => setTimeout(r, 2));
      expect(attempts).toBeGreaterThanOrEqual(2); // A is genuinely mid-retry
      const b = service.handleEvent(event('race b')).catch(() => {});
      await Promise.all([a, b]);
      // After ANY interleaving the connection is back at the configured value —
      // the registry mirror transactions rely on it and have no retry loop.
      expect(handle.sqlite.pragma('busy_timeout', { simple: true })).toBe(configured);
      expect(observedTimeouts).toEqual([configured, configured]); // never [500, 124]
    } finally {
      errSpy.mockRestore();
    }
  });
});
