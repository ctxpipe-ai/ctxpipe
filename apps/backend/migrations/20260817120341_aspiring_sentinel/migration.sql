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
CREATE TABLE "org_member_preferences" (
	"user_id" text,
	"org_id" text,
	"last_used_workspace_id" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "org_member_preferences_pkey" PRIMARY KEY("user_id","org_id")
);
--> statement-breakpoint
CREATE TABLE "org_workspace_cutover" (
	"org_id" text PRIMARY KEY,
	"first_workspace_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace_knowledge_units" (
	"serving_id" text PRIMARY KEY,
	"org_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"path" text NOT NULL,
	"body" text NOT NULL,
	"projection_sha" text NOT NULL,
	"links" jsonb DEFAULT '[]' NOT NULL,
	"claims" jsonb DEFAULT '[]' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"embedding" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_knowledge_units_workspace_id_path_uidx" UNIQUE("workspace_id","path")
);
--> statement-breakpoint
CREATE TABLE "workspace_linked_repositories" (
	"id" text PRIMARY KEY,
	"workspace_id" text NOT NULL,
	"git_url" text NOT NULL,
	"desired_ref" text,
	"desired_sha" text,
	"indexed_sha" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_linked_repositories_workspace_id_git_url_uidx" UNIQUE("workspace_id","git_url")
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
CREATE TABLE "workspace_write_jobs" (
	"id" text PRIMARY KEY,
	"workspace_id" text NOT NULL,
	"kind" text NOT NULL,
	"desired_sha" text,
	"commit_sha" text,
	"generation" integer NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" text PRIMARY KEY,
	"org_id" text NOT NULL,
	"slug" text NOT NULL,
	"display_name" text NOT NULL,
	"workspace_repository_url" text NOT NULL,
	"github_connection_id" text,
	"desired_generation" integer DEFAULT 1 NOT NULL,
	"desired_sha" text,
	"active_projection_url" text,
	"active_projection_sha" text,
	"indexed_sha" text,
	"write_status" text DEFAULT 'unknown' NOT NULL,
	"hydrate_status" text DEFAULT 'pending' NOT NULL,
	"hydrate_error" text,
	"last_job_at" timestamp with time zone,
	"hydrate_phases" jsonb,
	"read_only_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspaces_org_id_repository_url_uidx" UNIQUE("org_id","workspace_repository_url")
);
--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "workspace_id" text;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "last_branch" text;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "last_chat_pr_number" integer;--> statement-breakpoint
ALTER TABLE "conversations" ALTER COLUMN "name" SET DEFAULT 'New conversation';--> statement-breakpoint
CREATE INDEX "conversation_messages_conversation_id_idx" ON "conversation_messages" ("conversation_id");--> statement-breakpoint
CREATE INDEX "conversations_org_id_workspace_id_user_id_last_message_at_index" ON "conversations" ("org_id","workspace_id","user_id","last_message_at");--> statement-breakpoint
CREATE INDEX "workspace_knowledge_units_workspace_id_idx" ON "workspace_knowledge_units" ("workspace_id");--> statement-breakpoint
CREATE INDEX "workspace_knowledge_units_org_id_idx" ON "workspace_knowledge_units" ("org_id");--> statement-breakpoint
CREATE INDEX "workspace_linked_repositories_workspace_id_idx" ON "workspace_linked_repositories" ("workspace_id");--> statement-breakpoint
CREATE INDEX "workspace_sandbox_instances_workspace_id_idx" ON "workspace_sandbox_instances" ("workspace_id");--> statement-breakpoint
CREATE INDEX "workspace_sandbox_instances_conversation_id_idx" ON "workspace_sandbox_instances" ("conversation_id");--> statement-breakpoint
CREATE INDEX "workspace_write_jobs_workspace_id_idx" ON "workspace_write_jobs" ("workspace_id");--> statement-breakpoint
CREATE INDEX "workspace_write_jobs_workspace_id_status_idx" ON "workspace_write_jobs" ("workspace_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "workspaces_org_id_slug_uidx" ON "workspaces" ("org_id",lower("slug"));--> statement-breakpoint
CREATE INDEX "workspaces_org_id_idx" ON "workspaces" ("org_id");--> statement-breakpoint
ALTER TABLE "conversation_messages" ADD CONSTRAINT "conversation_messages_conversation_id_conversations_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "org_member_preferences" ADD CONSTRAINT "org_member_preferences_gzcoBbyuxOLm_fkey" FOREIGN KEY ("last_used_workspace_id") REFERENCES "workspaces"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "workspace_knowledge_units" ADD CONSTRAINT "workspace_knowledge_units_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "workspace_linked_repositories" ADD CONSTRAINT "workspace_linked_repositories_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "workspace_sandbox_instances" ADD CONSTRAINT "workspace_sandbox_instances_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "workspace_write_jobs" ADD CONSTRAINT "workspace_write_jobs_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_github_connection_id_connections_id_fkey" FOREIGN KEY ("github_connection_id") REFERENCES "connections"("id") ON DELETE SET NULL;