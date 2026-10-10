CREATE TABLE "chat_interrupts" (
	"interrupt_id" text PRIMARY KEY,
	"run_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"org_id" text NOT NULL,
	"status" text NOT NULL,
	"requested_at" bigint NOT NULL,
	"resolved_at" bigint,
	"payload_json" jsonb NOT NULL,
	"response_json" jsonb
);
--> statement-breakpoint
ALTER TABLE "chat_interrupts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "chat_metadata" (
	"namespace" text,
	"key" text,
	"org_id" text NOT NULL,
	"value_json" jsonb NOT NULL,
	CONSTRAINT "chat_metadata_pkey" PRIMARY KEY("namespace","key")
);
--> statement-breakpoint
ALTER TABLE "chat_metadata" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "chat_runs" (
	"run_id" text PRIMARY KEY,
	"thread_id" text NOT NULL,
	"org_id" text NOT NULL,
	"status" text NOT NULL,
	"started_at" bigint NOT NULL,
	"finished_at" bigint,
	"error" text,
	"error_code" text,
	"usage_json" jsonb,
	"sandbox_key" text,
	"detached_since" bigint,
	"cancel_requested" boolean,
	"driver_epoch" integer
);
--> statement-breakpoint
ALTER TABLE "chat_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "chat_threads" (
	"thread_id" text PRIMARY KEY,
	"org_id" text NOT NULL,
	"messages_json" jsonb NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chat_threads" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "chat_runs_status_detached" ON "chat_runs" ("status","detached_since");--> statement-breakpoint
CREATE INDEX "chat_runs_thread_started" ON "chat_runs" ("thread_id","started_at");--> statement-breakpoint
ALTER TABLE "chat_interrupts" ADD CONSTRAINT "chat_interrupts_thread_id_conversations_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "conversations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "chat_runs" ADD CONSTRAINT "chat_runs_thread_id_conversations_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "conversations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "chat_threads" ADD CONSTRAINT "chat_threads_thread_id_conversations_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "conversations"("id") ON DELETE CASCADE;--> statement-breakpoint
CREATE POLICY "org_isolation" ON "chat_interrupts" AS PERMISSIVE FOR ALL TO public USING ("chat_interrupts"."org_id" = current_setting('app.organization_id', true)) WITH CHECK ("chat_interrupts"."org_id" = current_setting('app.organization_id', true));--> statement-breakpoint
CREATE POLICY "org_isolation" ON "chat_metadata" AS PERMISSIVE FOR ALL TO public USING ("chat_metadata"."org_id" = current_setting('app.organization_id', true)) WITH CHECK ("chat_metadata"."org_id" = current_setting('app.organization_id', true));--> statement-breakpoint
CREATE POLICY "org_isolation" ON "chat_runs" AS PERMISSIVE FOR ALL TO public USING ("chat_runs"."org_id" = current_setting('app.organization_id', true)) WITH CHECK ("chat_runs"."org_id" = current_setting('app.organization_id', true));--> statement-breakpoint
CREATE POLICY "org_isolation" ON "chat_threads" AS PERMISSIVE FOR ALL TO public USING ("chat_threads"."org_id" = current_setting('app.organization_id', true)) WITH CHECK ("chat_threads"."org_id" = current_setting('app.organization_id', true));