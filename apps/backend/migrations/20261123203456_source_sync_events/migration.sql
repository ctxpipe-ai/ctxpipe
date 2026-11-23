CREATE TABLE "source_sync_events" (
	"id" text PRIMARY KEY,
	"org_id" text NOT NULL,
	"connection_id" text NOT NULL,
	"event" jsonb NOT NULL,
	"run_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "source_sync_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "source_sync_events_connection_id_idx" ON "source_sync_events" ("connection_id","created_at");--> statement-breakpoint
ALTER TABLE "source_sync_events" ADD CONSTRAINT "source_sync_events_connection_id_connections_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "connections"("id") ON DELETE CASCADE;--> statement-breakpoint
CREATE POLICY "org_isolation" ON "source_sync_events" AS PERMISSIVE FOR ALL TO public USING ("source_sync_events"."org_id" = current_setting('app.organization_id', true)) WITH CHECK ("source_sync_events"."org_id" = current_setting('app.organization_id', true));