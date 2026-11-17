CREATE TABLE `agents` (
	`name` text PRIMARY KEY NOT NULL,
	`project` text NOT NULL,
	`session` text NOT NULL,
	`ordinal` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `projects` (
	`name` text PRIMARY KEY NOT NULL
);
