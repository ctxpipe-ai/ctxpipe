CREATE TABLE "conversation_messages" (
	"id" text PRIMARY KEY,
	"conversation_id" text NOT NULL,
	"org_id" text NOT NULL,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"seq" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversation_messages_conversation_id_seq_uidx" UNIQUE("conversation_id","seq")
);
--> statement-breakpoint
CREATE TABLE "workspace_sandbox_instances" (
	"id" text PRIMARY KEY,
	"kind" text NOT NULL,
	"org_id" text,
	"workspace_id" text NOT NULL,
	"conversation_id" text,
	"desired_url" text,
	"desired_generation" integer,
	"desired_sha" text,
	"state" text DEFAULT 'live' NOT NULL,
	"last_heartbeat_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "conversation_messages_conversation_id_idx" ON "conversation_messages" ("conversation_id");--> statement-breakpoint
CREATE INDEX "workspace_sandbox_instances_workspace_id_idx" ON "workspace_sandbox_instances" ("workspace_id");--> statement-breakpoint
CREATE INDEX "workspace_sandbox_instances_conversation_id_idx" ON "workspace_sandbox_instances" ("conversation_id");--> statement-breakpoint
ALTER TABLE "conversation_messages" ADD CONSTRAINT "conversation_messages_conversation_id_conversations_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "workspace_sandbox_instances" ADD CONSTRAINT "workspace_sandbox_instances_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;