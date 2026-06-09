CREATE TABLE "agent_activity_events" (
	"id" text PRIMARY KEY,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"source" text NOT NULL,
	"event_type" text NOT NULL,
	"subject_id" text,
	"metadata" jsonb DEFAULT '{}' NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "agent_activity_events_org_occurred_idx" ON "agent_activity_events" ("org_id","occurred_at");--> statement-breakpoint
CREATE INDEX "agent_activity_events_org_user_occurred_idx" ON "agent_activity_events" ("org_id","user_id","occurred_at");--> statement-breakpoint
CREATE INDEX "agent_activity_events_org_source_occurred_idx" ON "agent_activity_events" ("org_id","source","occurred_at");--> statement-breakpoint
ALTER TABLE "agent_activity_events" ADD CONSTRAINT "agent_activity_events_org_id_organizations_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "agent_activity_events" ADD CONSTRAINT "agent_activity_events_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;