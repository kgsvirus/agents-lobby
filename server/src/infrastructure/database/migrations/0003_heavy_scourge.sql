PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_agents` (
	`name` text NOT NULL,
	`project` text NOT NULL,
	`session` text NOT NULL,
	`ordinal` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_agents`("name", "project", "session", "ordinal") SELECT "name", "project", "session", "ordinal" FROM `agents`;--> statement-breakpoint
DROP TABLE `agents`;--> statement-breakpoint
ALTER TABLE `__new_agents` RENAME TO `agents`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE TABLE `__new_registry_mirror` (
	`name` text NOT NULL,
	`role` text NOT NULL,
	`project` text NOT NULL,
	`session` text NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_registry_mirror`("name", "role", "project", "session") SELECT "name", "role", "project", "session" FROM `registry_mirror`;--> statement-breakpoint
DROP TABLE `registry_mirror`;--> statement-breakpoint
ALTER TABLE `__new_registry_mirror` RENAME TO `registry_mirror`;