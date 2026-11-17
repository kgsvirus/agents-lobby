// Server entry point: load config (zod-validated), build the app, listen.
// Dev binds 127.0.0.1:3006 by default (decisions 4–5); 3005 remains the legacy
// bridge's port until the Boss performs the cutover (Phase 7).
import { buildApp } from './app.js';
import { loadConfig } from './infrastructure/config/index.js';

const config = loadConfig();
const app = buildApp(config, { logger: true });

try {
  await app.listen({ host: config.host, port: config.port });
} catch (err) {
  app.log.error(err);
  // A failed listen must not leave the app's resources alive: the onClose
  // hooks (OpenCode event-stream unsubscribe, bus, db) only run on close(),
  // so without this the stream/retry timers can outlive the failed listen.
  await app.close().catch(() => {});
  process.exitCode = 1;
}
