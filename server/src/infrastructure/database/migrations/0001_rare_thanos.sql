CREATE TABLE `registry_mirror` (
	`name` text PRIMARY KEY NOT NULL,
	`role` text NOT NULL,
	`project` text NOT NULL,
	`session` text NOT NULL
);
