// Chat domain — HTTP query arithmetic (bridge.mjs:270-275 port).
//
// zod has already coerced/rejected the raw query params at the trust boundary;
// this function applies the bridge's EXACT arithmetic so compat semantics are
// preserved (decision 2): absent cursors → 0, and the limit falls back to 10
// for absent AND 0 (`Number(x) || 10` in the bridge — 0 is falsy), never
// letting a negative SQLite LIMIT ("no limit") through. Negative/garbage input
// is already rejected upstream (400 envelope — documented tightening).
export interface RawMessageQuery {
  readonly view?: string;
  readonly after?: number;
  readonly before?: number;
  readonly limit?: number;
}

export function parseMessageQuery(raw: RawMessageQuery) {
  return {
    view: raw.view ?? 'all',
    after: raw.after ?? 0,
    before: raw.before ?? 0,
    // Clamp: a negative SQLite LIMIT means "no limit" — never leak full history
    // by accident (bridge.mjs:274). 0 is falsy in the bridge's arithmetic → 10.
    limit: (raw.limit ?? 10) || 10,
  };
}
