CREATE TABLE "conversations" (
	"id" text PRIMARY KEY,
	"org_id" text NOT NULL,
	"name" text DEFAULT 'New Chat' NOT NULL,
	"source" text,
	"last_message_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP TABLE "repository_ingestion_errors";--> statement-breakpoint
DROP TABLE "repository_ingestion_queue";--> statement-breakpoint
CREATE INDEX "conversations_org_id_last_message_at_index" ON "conversations" ("org_id","last_message_at");--> statement-breakpoint
CREATE INDEX "conversations_org_id_source_index" ON "conversations" ("org_id","source");--> statement-breakpoint
CREATE INDEX "conversations_org_id_updated_at_index" ON "conversations" ("org_id","updated_at");