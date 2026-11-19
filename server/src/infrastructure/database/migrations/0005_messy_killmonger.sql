ALTER TABLE `messages` ADD `message_id` text;--> statement-breakpoint
ALTER TABLE `messages` ADD `capture_suppressed` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `messages` ADD `delivery_state` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_msg_message_id` ON `messages` (`message_id`);