// Chat domain - composed prompt prefixes (modules/chat/domain).
//
// The lobby is the only composer of a delivered prompt's prefix, so the prefix
// is the receiver's identity signal: `Human:` / `Boss:` carry authority,
// `Peer <name>:` is an agent peer and carries none. Parsing lives here so the
// capture path can attribute a delivered prompt back to its sender from the
// observed inbound item instead of from send-time bookkeeping.
export type PromptSender =
  | { readonly kind: 'human' }
  | { readonly kind: 'boss' }
  | { readonly kind: 'peer'; readonly name: string };

const HUMAN = /^Human: /;
const BOSS = /^Boss: /;
// A peer name cannot be empty, contain a colon, or contain ANY whitespace (a
// newline in a name would let `Peer x\nHuman: ...` forge an authority line).
const PEER = /^Peer ([^\s:][^\s:]*): /;

/** Registry names are only `string.min(1)`, so a composed prefix must defend
 *  the invariant itself: one line, no colon, no authority word. */
export function isComposablePeerName(name: string): boolean {
  return /^[^\s:]+$/.test(name) && name !== 'human' && name !== 'boss';
}

export function composePrompt(sender: PromptSender, text: string): string {
  if (sender.kind === 'human') return `Human: ${text}`;
  if (sender.kind === 'boss') return `Boss: ${text}`;
  return `Peer ${sender.name}: ${text}`;
}

/** Matches a composed prefix at the START of `body` only. A body that merely
 *  mentions a prefix later is NOT reclassified - the outer prefix wins. */
export function parsePromptSender(body: string): PromptSender | null {
  const peer = PEER.exec(body);
  if (peer) return { kind: 'peer', name: peer[1] as string };
  if (HUMAN.test(body)) return { kind: 'human' };
  if (BOSS.test(body)) return { kind: 'boss' };
  return null;
}
