CREATE TABLE `init_token_created` (
	`id` text PRIMARY KEY NOT NULL,
	`created` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `tokens` (
	`uid` text PRIMARY KEY NOT NULL,
	`name` text,
	`token_hash` text NOT NULL,
	`token_salt` text NOT NULL,
	`ip_addresses` text,
	`expires_at` text DEFAULT (datetime('now', '+90 days')) NOT NULL,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	`last_used_at` text,
	`init_token` integer DEFAULT 0 NOT NULL
);
