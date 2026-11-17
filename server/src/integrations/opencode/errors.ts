// OpenCode integration — NEUTRAL error contract (integrations/opencode/errors.ts).
//
// The stable entry point (index.ts) must never expose transport/wire concepts
// (URLs, pathnames, HTTP statuses, raw response bodies, OpenCode naming). The
// adapter keeps its rich internal `OpenCodeRequestError` (client.ts) for
// logging; everything the PORTS reject with is this neutral type. Rich details
// are logged HERE, inside the adapter, and are NOT attached to the thrown
// error (no `cause` carrying them across the boundary) — Phase 4 consumers
// branch on `code` only.
import { OpenCodeRequestError } from './client.js';

export type PortErrorCode =
  | 'unavailable'      // no effective server URL / network unreachable
  | 'timeout'          // upstream request timed out (decision 4)
  | 'upstream-error'   // upstream responded with an error status
  | 'invalid-response'; // upstream response failed validation at the trust boundary

export class PortError extends Error {
  readonly code: PortErrorCode;

  constructor(code: PortErrorCode, message: string) {
    super(message);
    this.name = 'PortError';
    this.code = code;
  }
}

/** Maps an adapter-internal failure to the neutral PortError a port rejects
 *  with. `operation` is a caller-facing phrase (may name the session handle —
 *  a domain datum per the event contract); it must never embed URLs, pathnames
 *  or raw bodies. The rich internal error is logged here, inside the adapter,
 *  and dropped from the thrown value. */
export function toPortError(operation: string, err: unknown): PortError {
  const rich = err instanceof OpenCodeRequestError ? err : undefined;
  let code: PortErrorCode;
  if (rich === undefined) {
    code = 'invalid-response'; // validation failures and any unexpected throw
  } else if (rich.status === 0) {
    const causeName = (rich.cause as { name?: string } | undefined)?.name;
    code = causeName === 'TimeoutError' || causeName === 'AbortError' ? 'timeout' : 'unavailable';
  } else {
    code = 'upstream-error';
  }
  console.error(`[opencode] ${operation} failed (${code})`, err); // details stay inside the adapter
  return new PortError(code, `${operation} failed (${code})`);
}
