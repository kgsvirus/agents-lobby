-- Baseline (Phase 2): reproduces the legacy schema (store.mjs:7-15, assessment §5)
-- plus the adjudicated `events` table (single shared Last-Event-ID cursor).
-- IF NOT EXISTS everywhere: the baseline must apply cleanly BOTH to a fresh db
-- AND to a populated legacy copy (decision 6) — legacy tables are left exactly
-- as they are, only `events` and the drizzle journal are added. Do not "fix"
-- this back to plain CREATE TABLE: drizzle-kit regenerations must keep it.
CREATE TABLE IF NOT EXISTS `bookmarks` (
	`consumer` text PRIMARY KEY,
	`last_seen_id` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`type` text NOT NULL,
	`payload` text NOT NULL,
	`ts` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `messages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ts` text NOT NULL,
	`sender` text NOT NULL,
	`receiver` text,
	`body` text NOT NULL,
	`session_id` text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_msg_receiver` ON `messages` (`receiver`,`id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_msg_sender` ON `messages` (`sender`,`id`);