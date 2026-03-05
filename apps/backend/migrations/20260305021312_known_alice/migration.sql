--> statement-breakpoint
ALTER TABLE "github_installations" ADD COLUMN "include_future_repos" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "github_installations" ALTER COLUMN "installation_id" SET DATA TYPE numeric USING "installation_id"::numeric;--> statement-breakpoint
ALTER TABLE "github_installations" ADD CONSTRAINT "github_installations_org_id_installation_id_unique" UNIQUE("org_id","installation_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "conversations_org_id_last_message_at_index" ON "conversations" ("org_id","last_message_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "conversations_org_id_source_index" ON "conversations" ("org_id","source");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "conversations_org_id_updated_at_index" ON "conversations" ("org_id","updated_at");