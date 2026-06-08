CREATE TABLE "init_token_created" (
	"id" varchar(16) PRIMARY KEY NOT NULL,
	"created" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
CREATE TABLE "tokens" (
	"uid" uuid PRIMARY KEY NOT NULL,
	"name" varchar(255),
	"token_hash" varchar(128) NOT NULL,
	"token_salt" varchar(64) NOT NULL,
	"expires_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"last_used_at" timestamp,
	"init_token" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_tokens_init" ON "tokens" USING btree ("init_token");
