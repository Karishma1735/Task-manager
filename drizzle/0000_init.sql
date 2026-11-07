CREATE TABLE `audit_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`at` text NOT NULL,
	`actor_id` integer,
	`action` text NOT NULL,
	`entity` text NOT NULL,
	`entity_id` text NOT NULL,
	`before_json` text,
	`after_json` text
);
--> statement-breakpoint
CREATE INDEX `audit_entity_idx` ON `audit_log` (`entity`,`entity_id`);--> statement-breakpoint
CREATE TABLE `day_notes` (
	`date` text NOT NULL,
	`reviewer_id` integer NOT NULL,
	`note` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`date`, `reviewer_id`),
	FOREIGN KEY (`date`) REFERENCES `days`(`date`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`reviewer_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `days` (
	`date` text PRIMARY KEY NOT NULL,
	`locked_at` text,
	`closed_at` text,
	`highlight` text,
	`learning` text
);
--> statement-breakpoint
CREATE TABLE `goals` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`week_start` text NOT NULL,
	`text` text NOT NULL,
	`measure` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `goals_week_idx` ON `goals` (`week_start`);--> statement-breakpoint
CREATE TABLE `notifications` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`event_id` text NOT NULL,
	`type` text NOT NULL,
	`payload_json` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`sent_at` text,
	CONSTRAINT "notifications_status_check" CHECK("notifications"."status" in ('pending','sent','failed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `notifications_event_unique` ON `notifications` (`event_id`);--> statement-breakpoint
CREATE TABLE `outcomes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`date` text NOT NULL,
	`position` integer NOT NULL,
	`title` text NOT NULL,
	`done_means` text NOT NULL,
	`level` integer NOT NULL,
	`goal_id` integer,
	`planned` integer NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`proof_url` text,
	`result` text,
	`reason` text,
	`carried_from` integer,
	`created_at` text NOT NULL,
	`closed_at` text,
	FOREIGN KEY (`date`) REFERENCES `days`(`date`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`goal_id`) REFERENCES `goals`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "outcomes_level_check" CHECK("outcomes"."level" in (1,2,4,8)),
	CONSTRAINT "outcomes_status_check" CHECK("outcomes"."status" in ('open','done','missed','carried'))
);
--> statement-breakpoint
CREATE INDEX `outcomes_date_idx` ON `outcomes` (`date`);--> statement-breakpoint
CREATE TABLE `reviews` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`outcome_id` integer NOT NULL,
	`reviewer_id` integer NOT NULL,
	`confirmed_points` integer NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`outcome_id`) REFERENCES `outcomes`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`reviewer_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "reviews_points_check" CHECK("reviews"."confirmed_points" in (0,1,2,4,8))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `reviews_outcome_reviewer_unique` ON `reviews` (`outcome_id`,`reviewer_id`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` integer NOT NULL,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `sessions_user_idx` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`password_hash` text NOT NULL,
	`role` text NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT "users_role_check" CHECK("users"."role" in ('owner','reviewer'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);