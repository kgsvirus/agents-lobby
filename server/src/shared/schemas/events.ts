// Typed event payloads for the internal event bus (single shared `events`
// sequence — assessment §7). Schemas live here; shared/types derives the TS
// map from them so there is one source of truth.
import { z } from 'zod';
import { wireMessageSchema } from './wire.js';

export const eventPayloadSchemas = {
  /** Payload = the wire message row; the messages table stays the content source of truth. */
  'message.created': wireMessageSchema,
  'agent.status_changed': z.object({
    name: z.string().min(1),
    status: z.string().min(1),
  }),
  'project.updated': z.object({
    name: z.string().min(1),
  }),
} as const satisfies Record<string, z.ZodType>;

export type EventPayloads = typeof eventPayloadSchemas;
