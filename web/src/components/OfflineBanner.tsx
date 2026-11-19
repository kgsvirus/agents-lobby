'use client';

import { Button } from './ui/button';

// Shown when a read failed: the dashboard otherwise looks like the data is
// simply empty, which is the misleading part.
export function OfflineBanner({ onRetry, detail }: { onRetry: () => void; detail?: string }) {
  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-2 border-b border-destructive/40 bg-destructive/10 px-3 py-1.5 text-xs text-destructive"
    >
      <span>{detail ?? "Can't reach the lobby API — showing the last data loaded."}</span>
      <Button
        variant="ghost"
        size="sm"
        onClick={onRetry}
        className="ml-auto h-6 px-2 text-[11.5px] text-destructive hover:bg-destructive/15"
      >
        Retry
      </Button>
    </div>
  );
}
