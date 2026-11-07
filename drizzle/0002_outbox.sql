CREATE TABLE `delivery_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`notification_id` integer NOT NULL,
	`at` text NOT NULL,
	`attempt` integer NOT NULL,
	`outcome` text NOT NULL,
	`http_status` integer,
	`error` text,
	FOREIGN KEY (`notification_id`) REFERENCES `notifications`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `delivery_log_notification_idx` ON `delivery_log` (`notification_id`);--> statement-breakpoint
ALTER TABLE `notifications` ADD `created_at` text DEFAULT '1970-01-01T00:00:00.000Z' NOT NULL;--> statement-breakpoint
ALTER TABLE `notifications` ADD `next_attempt_at` text;