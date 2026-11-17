// Wire shape of a message row, exactly as the legacy bridge/store exposes it
// (store.mjs:2,17: { id, time, from, to, text }). The event bus payload for
// `message.created` and the future /api/messages route share this schema.
import { z } from 'zod';

export const wireMessageSchema = z.object({
  id: z.number().int(),
  time: z.string(),
  from: z.string(),
  to: z.string().nullable(),
  text: z.string(),
});

export type WireMessage = z.infer<typeof wireMessageSchema>;
