// SSE subscription (new /api/events contract): named `message.created` frames
// carry the wire message row; other event types and malformed frames are
// ignored; the returned EventSource stays under the caller's control (the
// hook closes it on unmount and drives reconnect catch-up via onopen).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { subscribeStream } from '../src/lib/api';
import { FakeEventSource } from './fake-event-source';

afterEach(() => vi.unstubAllGlobals());

const wire = (id: number, from = 'boss', to: string | null = null): string =>
  JSON.stringify({ id, time: '2026-11-17T10:00:00.000Z', from, to, text: `m${id}` });

describe('subscribeStream', () => {
  it('dispatches message.created frames to the row callback', () => {
    vi.stubGlobal('EventSource', FakeEventSource);
    const onRow = vi.fn();
    const es = subscribeStream(onRow);
    expect(es).toBeInstanceOf(FakeEventSource);
    expect(es.url).toBe('/api/events');
    es.emit('message.created', wire(1));
    expect(onRow).toHaveBeenCalledWith(expect.objectContaining({ id: 1, from: 'boss' }));
  });

  it('ignores malformed frames and non-message event types', () => {
    const fake = new FakeEventSource();
    vi.stubGlobal('EventSource', vi.fn(() => fake));
    const onRow = vi.fn();
    subscribeStream(onRow);
    fake.emit('message.created', 'not json');
    fake.emit('agent.status_changed', JSON.stringify({ name: 'taskflow', status: 'busy' }));
    fake.emit('project.updated', JSON.stringify({ name: 'TaskFlow' }));
    expect(onRow).not.toHaveBeenCalled();
  });

  it('ignores lobby.checkpoint frames — they only seed the reconnect cursor', () => {
    const fake = new FakeEventSource();
    vi.stubGlobal('EventSource', vi.fn(() => fake));
    const onRow = vi.fn();
    subscribeStream(onRow);
    // Emitted on fresh connections (id = live head) so the native EventSource
    // auto-reconnect carries Last-Event-ID; the hook's bookkeeping must not
    // see it as a message row.
    fake.emit('lobby.checkpoint', '{"head":3}');
    expect(onRow).not.toHaveBeenCalled();
  });

  it('keeps dispatching across frames (hook dedupes by id)', () => {
    const fake = new FakeEventSource();
    vi.stubGlobal('EventSource', vi.fn(() => fake));
    const rows: number[] = [];
    subscribeStream((m) => rows.push(m.id));
    fake.emit('message.created', wire(3, 'taskflow', 'boss'));
    fake.emit('message.created', wire(5, 'boss'));
    expect(rows).toEqual([3, 5]);
  });
});
