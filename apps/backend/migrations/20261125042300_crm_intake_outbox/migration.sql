CREATE TABLE "crm_intake_outbox" (
	"id" text PRIMARY KEY,
	"user_id" text NOT NULL UNIQUE,
	"payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"failed_at" timestamp with time zone,
	"last_status" text
);
--> statement-breakpoint
CREATE INDEX "crm_intake_outbox_due_idx" ON "crm_intake_outbox" ("next_attempt_at") WHERE "sent_at" is null and "failed_at" is null;--> statement-breakpoint
ALTER TABLE "crm_intake_outbox" ADD CONSTRAINT "crm_intake_outbox_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;