DROP INDEX `idx_msg_message_id`;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_msg_message_id` ON `messages` (`message_id`,`sender`);