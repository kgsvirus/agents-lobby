// TS event map derived from the zod payload schemas — the type future domain
// modules import (no Fastify, no drizzle, no zod runtime dependency here).
import type { z } from 'zod';
import type { EventPayloads } from '../schemas/events.js';

export type EventType = keyof EventPayloads;

export type LobbyEventMap = {
  [K in EventType]: z.infer<EventPayloads[K]>;
};
