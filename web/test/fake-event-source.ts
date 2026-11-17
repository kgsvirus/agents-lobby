// Minimal EventSource double for the new /api/events contract. Mimics the
// native surface the app uses: addEventListener(type, handler), onopen,
// close(). emit()/open() stand in for server frames and (re)connections —
// a native EventSource re-opens on reconnect and re-sends its Last-Event-ID;
// the hook catches up on every open.
export class FakeEventSource {
  static instances: FakeEventSource[] = [];

  url: string;
  onopen: (() => void) | null = null;
  closed = false;
  private listeners = new Map<string, Array<(e: { data?: string }) => void>>();

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, handler: (e: { data?: string }) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(handler);
    this.listeners.set(type, list);
  }

  close(): void {
    this.closed = true;
  }

  emit(type: string, data: string): void {
    for (const handler of this.listeners.get(type) ?? []) handler({ data });
  }

  open(): void {
    this.onopen?.();
  }
}
