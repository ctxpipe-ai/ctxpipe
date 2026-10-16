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
CREATE TABLE "connection_directory" (
	"connection_id" text PRIMARY KEY,
	"org_id" text NOT NULL,
	"type" text NOT NULL,
	"github_installation_id" text,
	"slack_team_id" text,
	"linear_workspace_id" text,
	"notion_workspace_id" text,
	"notion_bot_id" text,
	"forge_cloud_id" text,
	"forge_installation_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
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
ALTER TABLE "conversation_messages" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "oauth_grant_organizations" (
	"grant_id" text,
	"api_key_id" text,
	"organization_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "oauth_grant_organizations_one_owner" CHECK (num_nonnulls("grant_id", "api_key_id") = 1)
);
--> statement-breakpoint
CREATE TABLE "repository_ingestion_requests" (
	"repository_id" text PRIMARY KEY,
	"org_id" text NOT NULL,
	"request_id" text NOT NULL,
	"target_branch" text,
	"indexing_reason" text,
	"repository_url" text NOT NULL,
	"github_connection_id" text,
	"workflow_run_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "repository_ingestion_requests" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "repository_extraction_captures" (
	"org_id" text NOT NULL,
	"repository_id" text,
	"source_sha" text,
	"scope" text,
	"extractor_version" integer,
	"root" text,
	"objects" jsonb NOT NULL,
	"claims" jsonb NOT NULL,
	"skipped_files" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "repository_extraction_captures_pkey" PRIMARY KEY("repository_id","source_sha","scope","extractor_version","root")
);
--> statement-breakpoint
ALTER TABLE "repository_extraction_captures" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "sandbox_locks" (
	"org_id" text,
	"key" text,
	"owner" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "sandbox_locks_pkey" PRIMARY KEY("org_id","key")
);
--> statement-breakpoint
ALTER TABLE "sandbox_locks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "workspace_sources" (
	"id" text PRIMARY KEY,
	"org_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"source_key" text NOT NULL,
	"connection_id" text,
	"provider" text,
	"scope" jsonb DEFAULT '{}' NOT NULL,
	"status" text NOT NULL,
	"status_detail" text,
	"state" jsonb DEFAULT '{}' NOT NULL,
	"revision" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_sources_workspace_id_source_key_uidx" UNIQUE("workspace_id","source_key")
);
--> statement-breakpoint
ALTER TABLE "workspace_sources" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "org_first_workspaces" (
	"org_id" text PRIMARY KEY,
	"workspace_id" text NOT NULL,
	"source_repository_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "org_first_workspaces" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "org_member_preferences" (
	"user_id" text,
	"org_id" text,
	"last_used_workspace_id" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "org_member_preferences_pkey" PRIMARY KEY("user_id","org_id")
);
--> statement-breakpoint
ALTER TABLE "org_member_preferences" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "workspace_commit_projections" (
	"workspace_id" text PRIMARY KEY,
	"org_id" text NOT NULL,
	"head_sha" text,
	"backfill_status" text DEFAULT 'pending' NOT NULL,
	"backfilled_since" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workspace_commit_projections" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "workspace_knowledge_chunks" (
	"workspace_id" text,
	"unit_id" text,
	"chunk_hash" text,
	"occurrence" integer,
	"org_id" text NOT NULL,
	"ordinal" integer NOT NULL,
	"start_line" integer NOT NULL,
	"end_line" integer NOT NULL,
	"text" text NOT NULL,
	"search" tsvector GENERATED ALWAYS AS (to_tsvector('english', "text")) STORED NOT NULL,
	"embedding" vector(2000),
	CONSTRAINT "workspace_knowledge_chunks_pkey" PRIMARY KEY("workspace_id","unit_id","chunk_hash","occurrence")
);
--> statement-breakpoint
ALTER TABLE "workspace_knowledge_chunks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "workspace_knowledge_path_state" (
	"workspace_id" text PRIMARY KEY,
	"org_id" text NOT NULL,
	"revision" jsonb NOT NULL,
	"paths" jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workspace_knowledge_path_state" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "workspace_knowledge_units" (
	"serving_id" text PRIMARY KEY,
	"org_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"path" text NOT NULL,
	"kind" text,
	"title" text,
	"source" text,
	"body" text NOT NULL,
	"projection_sha" text NOT NULL,
	"links" jsonb DEFAULT '[]' NOT NULL,
	"claims" jsonb DEFAULT '[]' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_knowledge_units_workspace_id_path_uidx" UNIQUE("workspace_id","path")
);
--> statement-breakpoint
ALTER TABLE "workspace_knowledge_units" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "workspace_repository_commits" (
	"org_id" text NOT NULL,
	"workspace_id" text,
	"sha" text,
	"committed_at" timestamp with time zone NOT NULL,
	"author_name" text NOT NULL,
	"author_login" text,
	"subject" text NOT NULL,
	"html_url" text,
	CONSTRAINT "workspace_repository_commits_pkey" PRIMARY KEY("workspace_id","sha")
);
--> statement-breakpoint
ALTER TABLE "workspace_repository_commits" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "workspace_sandbox_git_tokens" (
	"sandbox_id" text PRIMARY KEY,
	"org_id" text NOT NULL,
	"token_ciphertext" text NOT NULL,
	"minted_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workspace_sandbox_git_tokens" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "workspace_sandbox_instances" (
	"id" text PRIMARY KEY,
	"kind" text NOT NULL,
	"org_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"conversation_id" text,
	"desired_url" text,
	"desired_generation" integer,
	"desired_sha" text,
	"provider" text,
	"provider_sandbox_id" text,
	"image" text,
	"revision" jsonb,
	"latest_snapshot_id" text,
	"latest_run_id" text,
	"state" text DEFAULT 'live' NOT NULL,
	"last_heartbeat_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workspace_sandbox_instances" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "workspace_write_jobs" (
	"id" text PRIMARY KEY,
	"org_id" text NOT NULL,
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
ALTER TABLE "workspace_write_jobs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" text PRIMARY KEY,
	"org_id" text NOT NULL,
	"slug" text NOT NULL,
	"display_name" text NOT NULL,
	"workspace_repository_url" text NOT NULL,
	"root_path" text DEFAULT '' NOT NULL,
	"github_connection_id" text,
	"desired_generation" integer DEFAULT 1 NOT NULL,
	"desired_sha" text,
	"desired_default_branch" text,
	"active_revision" jsonb,
	"active_projection_url" text,
	"active_projection_sha" text,
	"indexed_sha" text,
	"write_status" text DEFAULT 'unknown' NOT NULL,
	"hydrate_status" text DEFAULT 'pending' NOT NULL,
	"hydrate_error" text,
	"last_job_at" timestamp with time zone,
	"hydrate_phases" jsonb,
	"read_only_reason" text,
	"format_version" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspaces_org_id_repository_url_uidx" UNIQUE("org_id","workspace_repository_url")
);
--> statement-breakpoint
ALTER TABLE "workspaces" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "claim_evidence" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "claims" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "confluence_spaces" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "confluence_sync_targets" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "connections" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "conversations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "objects" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "org_onboarding" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "repositories" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "repository_checkouts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "claim_evidence" ADD COLUMN "org_id" text;--> statement-breakpoint
ALTER TABLE "confluence_spaces" ADD COLUMN "org_id" text;--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "content_sync_generation" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "content_sync_workflow_run_id" text;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "workspace_id" text;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "last_branch" text;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "last_pushed_sha" text;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "last_chat_pr_number" integer;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "last_chat_pr_revision" jsonb;--> statement-breakpoint
ALTER TABLE "repositories" ADD COLUMN "repository_key" text;--> statement-breakpoint
ALTER TABLE "repository_checkouts" ADD COLUMN "org_id" text;--> statement-breakpoint
ALTER TABLE "conversations" ALTER COLUMN "name" SET DEFAULT 'New conversation';--> statement-breakpoint
CREATE INDEX "chat_runs_status_detached" ON "chat_runs" ("status","detached_since");--> statement-breakpoint
CREATE INDEX "chat_runs_thread_started" ON "chat_runs" ("thread_id","started_at");--> statement-breakpoint
CREATE INDEX "claim_evidence_org_id_idx" ON "claim_evidence" ("org_id");--> statement-breakpoint
CREATE INDEX "confluence_spaces_org_id_idx" ON "confluence_spaces" ("org_id");--> statement-breakpoint
CREATE INDEX "connection_directory_org_id_idx" ON "connection_directory" ("org_id");--> statement-breakpoint
CREATE INDEX "connection_directory_github_installation_id_idx" ON "connection_directory" ("github_installation_id");--> statement-breakpoint
CREATE INDEX "connection_directory_slack_team_id_idx" ON "connection_directory" ("slack_team_id");--> statement-breakpoint
CREATE INDEX "connection_directory_linear_workspace_id_idx" ON "connection_directory" ("linear_workspace_id");--> statement-breakpoint
CREATE INDEX "connection_directory_notion_workspace_id_idx" ON "connection_directory" ("notion_workspace_id");--> statement-breakpoint
CREATE INDEX "connection_directory_notion_bot_id_idx" ON "connection_directory" ("notion_bot_id");--> statement-breakpoint
CREATE INDEX "connection_directory_forge_cloud_id_idx" ON "connection_directory" ("forge_cloud_id");--> statement-breakpoint
CREATE INDEX "connection_directory_forge_installation_id_idx" ON "connection_directory" ("forge_installation_id");--> statement-breakpoint
CREATE INDEX "conversation_messages_conversation_id_idx" ON "conversation_messages" ("conversation_id");--> statement-breakpoint
CREATE INDEX "conversations_org_id_workspace_id_user_id_last_message_at_index" ON "conversations" ("org_id","workspace_id","user_id","last_message_at");--> statement-breakpoint
CREATE UNIQUE INDEX "oauth_grant_organizations_grant_org_uidx" ON "oauth_grant_organizations" ("grant_id","organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "oauth_grant_organizations_api_key_org_uidx" ON "oauth_grant_organizations" ("api_key_id","organization_id");--> statement-breakpoint
CREATE INDEX "oauth_grant_organizations_organization_id_idx" ON "oauth_grant_organizations" ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "repositories_org_id_repository_key_uidx" ON "repositories" ("org_id","repository_key");--> statement-breakpoint
CREATE UNIQUE INDEX "repository_ingestion_requests_request_id_uidx" ON "repository_ingestion_requests" ("request_id");--> statement-breakpoint
CREATE INDEX "repository_checkouts_org_id_idx" ON "repository_checkouts" ("org_id");--> statement-breakpoint
CREATE INDEX "repository_extraction_captures_org_id_idx" ON "repository_extraction_captures" ("org_id");--> statement-breakpoint
CREATE INDEX "workspace_sources_connection_id_idx" ON "workspace_sources" ("connection_id");--> statement-breakpoint
CREATE INDEX "workspace_sources_org_id_idx" ON "workspace_sources" ("org_id");--> statement-breakpoint
CREATE INDEX "workspace_commit_projections_org_id_idx" ON "workspace_commit_projections" ("org_id");--> statement-breakpoint
CREATE INDEX "workspace_knowledge_chunks_workspace_id_hash_idx" ON "workspace_knowledge_chunks" ("workspace_id","chunk_hash");--> statement-breakpoint
CREATE INDEX "workspace_knowledge_chunks_org_id_idx" ON "workspace_knowledge_chunks" ("org_id");--> statement-breakpoint
CREATE INDEX "workspace_knowledge_chunks_search_idx" ON "workspace_knowledge_chunks" USING gin ("search");--> statement-breakpoint
CREATE INDEX "workspace_knowledge_chunks_embedding_idx" ON "workspace_knowledge_chunks" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "workspace_knowledge_units_workspace_id_idx" ON "workspace_knowledge_units" ("workspace_id");--> statement-breakpoint
CREATE INDEX "workspace_knowledge_units_org_id_idx" ON "workspace_knowledge_units" ("org_id");--> statement-breakpoint
CREATE INDEX "workspace_repository_commits_workspace_committed_at_idx" ON "workspace_repository_commits" ("workspace_id","committed_at");--> statement-breakpoint
CREATE INDEX "workspace_repository_commits_org_id_idx" ON "workspace_repository_commits" ("org_id");--> statement-breakpoint
CREATE INDEX "workspace_sandbox_instances_workspace_id_idx" ON "workspace_sandbox_instances" ("workspace_id");--> statement-breakpoint
CREATE INDEX "workspace_sandbox_instances_conversation_id_idx" ON "workspace_sandbox_instances" ("conversation_id");--> statement-breakpoint
CREATE INDEX "workspace_sandbox_instances_org_id_idx" ON "workspace_sandbox_instances" ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_sandbox_instances_live_job_workspace_uidx" ON "workspace_sandbox_instances" ("workspace_id") WHERE "kind" = 'job' and "state" in ('live', 'destroy_failed');--> statement-breakpoint
CREATE INDEX "workspace_write_jobs_workspace_id_idx" ON "workspace_write_jobs" ("workspace_id");--> statement-breakpoint
CREATE INDEX "workspace_write_jobs_workspace_id_status_idx" ON "workspace_write_jobs" ("workspace_id","status");--> statement-breakpoint
CREATE INDEX "workspace_write_jobs_org_id_idx" ON "workspace_write_jobs" ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workspaces_org_id_slug_uidx" ON "workspaces" ("org_id",lower("slug"));--> statement-breakpoint
CREATE INDEX "workspaces_org_id_idx" ON "workspaces" ("org_id");--> statement-breakpoint
ALTER TABLE "chat_interrupts" ADD CONSTRAINT "chat_interrupts_thread_id_conversations_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "conversations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "chat_runs" ADD CONSTRAINT "chat_runs_thread_id_conversations_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "conversations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "chat_threads" ADD CONSTRAINT "chat_threads_thread_id_conversations_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "conversations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "conversation_messages" ADD CONSTRAINT "conversation_messages_conversation_id_conversations_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "oauth_grant_organizations" ADD CONSTRAINT "oauth_grant_organizations_api_key_id_apikeys_id_fkey" FOREIGN KEY ("api_key_id") REFERENCES "apikeys"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "oauth_grant_organizations" ADD CONSTRAINT "oauth_grant_organizations_organization_id_organizations_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "repository_ingestion_requests" ADD CONSTRAINT "repository_ingestion_requests_ZwLAikCC14ZA_fkey" FOREIGN KEY ("repository_id") REFERENCES "repositories"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "repository_extraction_captures" ADD CONSTRAINT "repository_extraction_captures_64ScVXTtwZsy_fkey" FOREIGN KEY ("repository_id") REFERENCES "repositories"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "sandbox_locks" ADD CONSTRAINT "sandbox_locks_org_id_organizations_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "workspace_sources" ADD CONSTRAINT "workspace_sources_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "org_first_workspaces" ADD CONSTRAINT "org_first_workspaces_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "org_member_preferences" ADD CONSTRAINT "org_member_preferences_gzcoBbyuxOLm_fkey" FOREIGN KEY ("last_used_workspace_id") REFERENCES "workspaces"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "workspace_commit_projections" ADD CONSTRAINT "workspace_commit_projections_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "workspace_knowledge_chunks" ADD CONSTRAINT "workspace_knowledge_chunks_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "workspace_knowledge_path_state" ADD CONSTRAINT "workspace_knowledge_path_state_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "workspace_knowledge_units" ADD CONSTRAINT "workspace_knowledge_units_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "workspace_repository_commits" ADD CONSTRAINT "workspace_repository_commits_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "workspace_sandbox_instances" ADD CONSTRAINT "workspace_sandbox_instances_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "workspace_write_jobs" ADD CONSTRAINT "workspace_write_jobs_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_github_connection_id_connections_id_fkey" FOREIGN KEY ("github_connection_id") REFERENCES "connections"("id") ON DELETE SET NULL;--> statement-breakpoint
CREATE POLICY "org_isolation" ON "chat_interrupts" AS PERMISSIVE FOR ALL TO public USING ("chat_interrupts"."org_id" = current_setting('app.organization_id', true)) WITH CHECK ("chat_interrupts"."org_id" = current_setting('app.organization_id', true));--> statement-breakpoint
CREATE POLICY "org_isolation" ON "chat_metadata" AS PERMISSIVE FOR ALL TO public USING ("chat_metadata"."org_id" = current_setting('app.organization_id', true)) WITH CHECK ("chat_metadata"."org_id" = current_setting('app.organization_id', true));--> statement-breakpoint
CREATE POLICY "org_isolation" ON "chat_runs" AS PERMISSIVE FOR ALL TO public USING ("chat_runs"."org_id" = current_setting('app.organization_id', true)) WITH CHECK ("chat_runs"."org_id" = current_setting('app.organization_id', true));--> statement-breakpoint
CREATE POLICY "org_isolation" ON "chat_threads" AS PERMISSIVE FOR ALL TO public USING ("chat_threads"."org_id" = current_setting('app.organization_id', true)) WITH CHECK ("chat_threads"."org_id" = current_setting('app.organization_id', true));--> statement-breakpoint
CREATE POLICY "org_isolation" ON "claim_evidence" AS PERMISSIVE FOR ALL TO public USING ("claim_evidence"."org_id" = current_setting('app.organization_id', true)) WITH CHECK ("claim_evidence"."org_id" = current_setting('app.organization_id', true));--> statement-breakpoint
CREATE POLICY "org_isolation" ON "claims" AS PERMISSIVE FOR ALL TO public USING ("claims"."org_id" = current_setting('app.organization_id', true)) WITH CHECK ("claims"."org_id" = current_setting('app.organization_id', true));--> statement-breakpoint
CREATE POLICY "org_isolation" ON "confluence_spaces" AS PERMISSIVE FOR ALL TO public USING ("confluence_spaces"."org_id" = current_setting('app.organization_id', true)) WITH CHECK ("confluence_spaces"."org_id" = current_setting('app.organization_id', true));--> statement-breakpoint
CREATE POLICY "org_isolation" ON "confluence_sync_targets" AS PERMISSIVE FOR ALL TO public USING ("confluence_sync_targets"."org_id" = current_setting('app.organization_id', true)) WITH CHECK ("confluence_sync_targets"."org_id" = current_setting('app.organization_id', true));--> statement-breakpoint
CREATE POLICY "org_isolation" ON "connections" AS PERMISSIVE FOR ALL TO public USING ("connections"."org_id" = current_setting('app.organization_id', true)) WITH CHECK ("connections"."org_id" = current_setting('app.organization_id', true));--> statement-breakpoint
CREATE POLICY "org_isolation" ON "conversation_messages" AS PERMISSIVE FOR ALL TO public USING ("conversation_messages"."org_id" = current_setting('app.organization_id', true)) WITH CHECK ("conversation_messages"."org_id" = current_setting('app.organization_id', true));--> statement-breakpoint
CREATE POLICY "org_isolation" ON "conversations" AS PERMISSIVE FOR ALL TO public USING ("conversations"."org_id" = current_setting('app.organization_id', true)) WITH CHECK ("conversations"."org_id" = current_setting('app.organization_id', true));--> statement-breakpoint
CREATE POLICY "org_isolation" ON "objects" AS PERMISSIVE FOR ALL TO public USING ("objects"."org_id" = current_setting('app.organization_id', true)) WITH CHECK ("objects"."org_id" = current_setting('app.organization_id', true));--> statement-breakpoint
CREATE POLICY "org_isolation" ON "org_onboarding" AS PERMISSIVE FOR ALL TO public USING ("org_onboarding"."organization_id" = current_setting('app.organization_id', true)) WITH CHECK ("org_onboarding"."organization_id" = current_setting('app.organization_id', true));--> statement-breakpoint
CREATE POLICY "org_isolation" ON "repositories" AS PERMISSIVE FOR ALL TO public USING ("repositories"."org_id" = current_setting('app.organization_id', true)) WITH CHECK ("repositories"."org_id" = current_setting('app.organization_id', true));--> statement-breakpoint
CREATE POLICY "org_isolation" ON "repository_ingestion_requests" AS PERMISSIVE FOR ALL TO public USING ("repository_ingestion_requests"."org_id" = current_setting('app.organization_id', true)) WITH CHECK ("repository_ingestion_requests"."org_id" = current_setting('app.organization_id', true));--> statement-breakpoint
CREATE POLICY "org_isolation" ON "repository_checkouts" AS PERMISSIVE FOR ALL TO public USING ("repository_checkouts"."org_id" = current_setting('app.organization_id', true)) WITH CHECK ("repository_checkouts"."org_id" = current_setting('app.organization_id', true));--> statement-breakpoint
CREATE POLICY "org_isolation" ON "repository_extraction_captures" AS PERMISSIVE FOR ALL TO public USING ("repository_extraction_captures"."org_id" = current_setting('app.organization_id', true)) WITH CHECK ("repository_extraction_captures"."org_id" = current_setting('app.organization_id', true));--> statement-breakpoint
CREATE POLICY "org_isolation" ON "sandbox_locks" AS PERMISSIVE FOR ALL TO public USING ("sandbox_locks"."org_id" = current_setting('app.organization_id', true)) WITH CHECK ("sandbox_locks"."org_id" = current_setting('app.organization_id', true));--> statement-breakpoint
CREATE POLICY "org_isolation" ON "workspace_sources" AS PERMISSIVE FOR ALL TO public USING ("workspace_sources"."org_id" = current_setting('app.organization_id', true)) WITH CHECK ("workspace_sources"."org_id" = current_setting('app.organization_id', true));--> statement-breakpoint
CREATE POLICY "org_isolation" ON "org_first_workspaces" AS PERMISSIVE FOR ALL TO public USING ("org_first_workspaces"."org_id" = current_setting('app.organization_id', true)) WITH CHECK ("org_first_workspaces"."org_id" = current_setting('app.organization_id', true));--> statement-breakpoint
CREATE POLICY "org_isolation" ON "org_member_preferences" AS PERMISSIVE FOR ALL TO public USING ("org_member_preferences"."org_id" = current_setting('app.organization_id', true)) WITH CHECK ("org_member_preferences"."org_id" = current_setting('app.organization_id', true));--> statement-breakpoint
CREATE POLICY "org_isolation" ON "workspace_commit_projections" AS PERMISSIVE FOR ALL TO public USING ("workspace_commit_projections"."org_id" = current_setting('app.organization_id', true)) WITH CHECK ("workspace_commit_projections"."org_id" = current_setting('app.organization_id', true));--> statement-breakpoint
CREATE POLICY "org_isolation" ON "workspace_knowledge_chunks" AS PERMISSIVE FOR ALL TO public USING ("workspace_knowledge_chunks"."org_id" = current_setting('app.organization_id', true)) WITH CHECK ("workspace_knowledge_chunks"."org_id" = current_setting('app.organization_id', true));--> statement-breakpoint
CREATE POLICY "org_isolation" ON "workspace_knowledge_path_state" AS PERMISSIVE FOR ALL TO public USING ("workspace_knowledge_path_state"."org_id" = current_setting('app.organization_id', true)) WITH CHECK ("workspace_knowledge_path_state"."org_id" = current_setting('app.organization_id', true));--> statement-breakpoint
CREATE POLICY "org_isolation" ON "workspace_knowledge_units" AS PERMISSIVE FOR ALL TO public USING ("workspace_knowledge_units"."org_id" = current_setting('app.organization_id', true)) WITH CHECK ("workspace_knowledge_units"."org_id" = current_setting('app.organization_id', true));--> statement-breakpoint
CREATE POLICY "org_isolation" ON "workspace_repository_commits" AS PERMISSIVE FOR ALL TO public USING ("workspace_repository_commits"."org_id" = current_setting('app.organization_id', true)) WITH CHECK ("workspace_repository_commits"."org_id" = current_setting('app.organization_id', true));--> statement-breakpoint
CREATE POLICY "org_isolation" ON "workspace_sandbox_git_tokens" AS PERMISSIVE FOR ALL TO public USING ("workspace_sandbox_git_tokens"."org_id" = current_setting('app.organization_id', true)) WITH CHECK ("workspace_sandbox_git_tokens"."org_id" = current_setting('app.organization_id', true));--> statement-breakpoint
CREATE POLICY "org_isolation" ON "workspace_sandbox_instances" AS PERMISSIVE FOR ALL TO public USING ("workspace_sandbox_instances"."org_id" = current_setting('app.organization_id', true)) WITH CHECK ("workspace_sandbox_instances"."org_id" = current_setting('app.organization_id', true));--> statement-breakpoint
CREATE POLICY "org_isolation" ON "workspace_write_jobs" AS PERMISSIVE FOR ALL TO public USING ("workspace_write_jobs"."org_id" = current_setting('app.organization_id', true)) WITH CHECK ("workspace_write_jobs"."org_id" = current_setting('app.organization_id', true));--> statement-breakpoint
CREATE POLICY "org_isolation" ON "workspaces" AS PERMISSIVE FOR ALL TO public USING ("workspaces"."org_id" = current_setting('app.organization_id', true)) WITH CHECK ("workspaces"."org_id" = current_setting('app.organization_id', true));--> statement-breakpoint
-- The statements below are hand-written. drizzle-kit does not generate them:
-- data backfills from the main schema, and the expand-only org_id triggers (ADR-053).
INSERT INTO "connection_directory" (
	"connection_id",
	"org_id",
	"type",
	"github_installation_id",
	"slack_team_id",
	"linear_workspace_id",
	"notion_workspace_id",
	"notion_bot_id",
	"forge_cloud_id",
	"forge_installation_id",
	"created_at",
	"updated_at"
)
SELECT
	"id",
	"org_id",
	"type",
	CASE WHEN "type" = 'github' THEN NULLIF("config"->>'installationId', '') END,
	CASE WHEN "type" = 'slack' THEN NULLIF("config"->>'teamId', '') END,
	CASE WHEN "type" = 'linear' THEN NULLIF("config"->>'workspaceId', '') END,
	CASE WHEN "type" = 'notion' THEN NULLIF("config"->>'workspaceId', '') END,
	CASE WHEN "type" = 'notion' THEN NULLIF("config"->>'botId', '') END,
	CASE WHEN "type" = 'forge' THEN NULLIF("config"->>'cloudId', '') END,
	CASE WHEN "type" = 'forge' THEN NULLIF("config"->>'installationId', '') END,
	"created_at",
	"updated_at"
FROM "connections";
--> statement-breakpoint
UPDATE "claim_evidence" AS e SET "org_id" = c."org_id" FROM "claims" AS c WHERE e."claim_id" = c."id" AND e."org_id" IS NULL;--> statement-breakpoint
UPDATE "confluence_spaces" AS s SET "org_id" = c."org_id" FROM "connections" AS c WHERE s."connection_id" = c."id" AND s."org_id" IS NULL;--> statement-breakpoint
UPDATE "repository_checkouts" AS ch SET "org_id" = r."org_id" FROM "repositories" AS r WHERE ch."repository_id" = r."id" AND ch."org_id" IS NULL;--> statement-breakpoint
-- Expand-only: "claim_evidence", "confluence_spaces" and "repository_checkouts"
-- keep a nullable "org_id" in this minor release, so that the previous image can still
-- write rows after a rollback. RLS hides rows with no org from the app role. The next
-- major release sets NOT NULL. The DELETE of orphan rows runs in the migration
-- transaction, so a failed migration deletes nothing.
DELETE FROM "claim_evidence" WHERE "org_id" IS NULL;--> statement-breakpoint
DELETE FROM "confluence_spaces" WHERE "org_id" IS NULL;--> statement-breakpoint
DELETE FROM "repository_checkouts" WHERE "org_id" IS NULL;--> statement-breakpoint
-- Expand-only: after a rollback, the previous image writes these rows with no
-- "org_id". These BEFORE INSERT triggers copy "org_id" from the parent row, so that
-- the app role can see the rows after the next upgrade. The functions run with the
-- rights of the caller, so RLS on the parent table applies to the app role. The next
-- major release sets NOT NULL and drops these triggers.
CREATE FUNCTION "claim_evidence_fill_org_id"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF NEW."org_id" IS NULL THEN
		NEW."org_id" := (SELECT c."org_id" FROM "public"."claims" AS c WHERE c."id" = NEW."claim_id");
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "claim_evidence_fill_org_id" BEFORE INSERT ON "claim_evidence" FOR EACH ROW EXECUTE FUNCTION "claim_evidence_fill_org_id"();--> statement-breakpoint
CREATE FUNCTION "confluence_spaces_fill_org_id"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF NEW."org_id" IS NULL THEN
		NEW."org_id" := (SELECT c."org_id" FROM "public"."connections" AS c WHERE c."id" = NEW."connection_id");
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "confluence_spaces_fill_org_id" BEFORE INSERT ON "confluence_spaces" FOR EACH ROW EXECUTE FUNCTION "confluence_spaces_fill_org_id"();--> statement-breakpoint
CREATE FUNCTION "repository_checkouts_fill_org_id"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF NEW."org_id" IS NULL THEN
		NEW."org_id" := (SELECT r."org_id" FROM "public"."repositories" AS r WHERE r."id" = NEW."repository_id");
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "repository_checkouts_fill_org_id" BEFORE INSERT ON "repository_checkouts" FOR EACH ROW EXECUTE FUNCTION "repository_checkouts_fill_org_id"();
--> statement-breakpoint
-- One-shot dest Workspace backfill. SQL rows only — do not enqueue OpenWorkflow.
CREATE OR REPLACE FUNCTION tmp_normalize_workspace_repository_url(raw text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  trimmed text;
  host text;
  path text;
BEGIN
  IF raw IS NULL THEN
    RETURN '';
  END IF;
  trimmed := btrim(raw);
  IF trimmed = '' THEN
    RETURN '';
  END IF;
  IF trimmed ~ '^git@[^:]+:.+$' THEN
    host := lower(substring(trimmed FROM '^git@([^:]+):'));
    path := substring(trimmed FROM '^git@[^:]+:(.+)$');
    path := regexp_replace(path, '\.git$', '', 'i');
    path := regexp_replace(path, '/+$', '');
    IF host = 'github.com' THEN
      RETURN 'https://github.com/' || path;
    END IF;
    RETURN 'https://' || host || '/' || path;
  END IF;
  trimmed := regexp_replace(trimmed, '[?#].*$', '');
  IF trimmed ~* '^https?://([^/]*@)?github\.com/' THEN
    path := regexp_replace(trimmed, '^https?://([^/]*@)?github\.com/', '', 'i');
    path := regexp_replace(path, '\.git$', '', 'i');
    path := regexp_replace(path, '/+$', '');
    RETURN 'https://github.com/' || path;
  END IF;
  trimmed := regexp_replace(trimmed, '\.git$', '', 'i');
  trimmed := regexp_replace(trimmed, '/+$', '');
  RETURN trimmed;
END;
$$;
--> statement-breakpoint
INSERT INTO "workspaces" (
  "id",
  "org_id",
  "slug",
  "display_name",
  "workspace_repository_url",
  "github_connection_id",
  "desired_generation",
  "write_status",
  "hydrate_status",
  "read_only_reason",
  "created_at",
  "updated_at"
)
SELECT
  'ws_' || replace(gen_random_uuid()::text, '-', ''),
  s.org_id,
  CASE
    WHEN s.slug_n = 1 THEN s.desired_slug
    WHEN NOT EXISTS (
      SELECT 1
      FROM "workspaces" w
      WHERE w."org_id" = s.org_id
        AND lower(w."slug") = s.numbered_slug
    ) THEN s.numbered_slug
    ELSE left(s.desired_slug, 55) || '-' || substr(md5(s.org_id || '|' || s.git_url), 1, 8)
  END,
  s.name,
  s.git_url,
  CASE
    WHEN EXISTS (
      SELECT 1 FROM "connections" c WHERE c."id" = s.github_connection_id
    ) THEN s.github_connection_id
    ELSE NULL
  END,
  1,
  CASE
    WHEN s.git_url NOT LIKE 'https://github.com/%' THEN 'read_only'
    WHEN s.github_connection_id IS NULL THEN 'read_only'
    ELSE 'unknown'
  END,
  'pending',
  CASE
    WHEN s.git_url NOT LIKE 'https://github.com/%' THEN
      'This remote is not GitHub. v1 can hydrate, search, and chat, but cannot commit or push. Relink to a GitHub repository the App can write.'
    WHEN s.github_connection_id IS NULL THEN
      'GitHub is not connected for this organisation. An owner or admin must install the GitHub App and add this repository to the installation.'
    ELSE NULL
  END,
  now(),
  now()
FROM (
  SELECT
    d.org_id,
    d.git_url,
    d.name,
    d.github_connection_id,
    d.desired_slug,
    CASE
      WHEN EXISTS (
        SELECT 1
        FROM "workspaces" w
        WHERE w."org_id" = d.org_id
          AND lower(w."slug") = d.desired_slug
      ) THEN d.seq + 1
      ELSE d.seq
    END AS slug_n,
    left(
      d.desired_slug,
      64 - length(
        '-' || (
          CASE
            WHEN EXISTS (
              SELECT 1
              FROM "workspaces" w
              WHERE w."org_id" = d.org_id
                AND lower(w."slug") = d.desired_slug
            ) THEN d.seq + 1
            ELSE d.seq
          END
        )::text
      )
    ) || '-' || (
      CASE
        WHEN EXISTS (
          SELECT 1
          FROM "workspaces" w
          WHERE w."org_id" = d.org_id
            AND lower(w."slug") = d.desired_slug
        ) THEN d.seq + 1
        ELSE d.seq
      END
    )::text AS numbered_slug
  FROM (
    SELECT
      dest.org_id,
      dest.git_url,
      dest.name,
      dest.github_connection_id,
      left(
        coalesce(
          nullif(
            trim(both '-' FROM regexp_replace(lower(dest.name), '[^a-z0-9]+', '-', 'g')),
            ''
          ),
          'workspace'
        ),
        64
      ) AS desired_slug,
      row_number() OVER (
        PARTITION BY dest.org_id,
          left(
            coalesce(
              nullif(
                trim(both '-' FROM regexp_replace(lower(dest.name), '[^a-z0-9]+', '-', 'g')),
                ''
              ),
              'workspace'
            ),
            64
          )
        ORDER BY dest.git_url
      ) AS seq
    FROM (
      SELECT DISTINCT ON (src.org_id, src.git_url)
        src.org_id,
        src.git_url,
        src.name,
        src.github_connection_id
      FROM (
        SELECT
          r."org_id" AS org_id,
          tmp_normalize_workspace_repository_url(r."git_url") AS git_url,
          r."name" AS name,
          r."github_connection_id" AS github_connection_id,
          r."created_at" AS created_at,
          r."id" AS repository_id
        FROM "confluence_sync_targets" t
        INNER JOIN "repositories" r
          ON r."id" = t."repository_id"
          AND r."org_id" = t."org_id"
        WHERE t."enabled" IS TRUE
        UNION ALL
        SELECT
          r."org_id",
          tmp_normalize_workspace_repository_url(r."git_url"),
          r."name",
          r."github_connection_id",
          r."created_at",
          r."id"
        FROM "connections" c
        INNER JOIN "repositories" r
          ON r."org_id" = c."org_id"
          AND r."id" = (c."config"->>'repositoryId')
        WHERE c."type" IN ('linear', 'notion', 'slack')
          AND (c."config"->>'enabled')::boolean IS TRUE
          AND nullif(btrim(c."config"->>'repositoryId'), '') IS NOT NULL
      ) src
      WHERE src.git_url <> ''
      ORDER BY src.org_id, src.git_url, src.created_at, src.repository_id
    ) dest
    WHERE NOT EXISTS (
      SELECT 1
      FROM "workspaces" w
      WHERE w."org_id" = dest.org_id
        AND w."workspace_repository_url" = dest.git_url
    )
  ) d
) s
ON CONFLICT ON CONSTRAINT "workspaces_org_id_repository_url_uidx" DO NOTHING;
--> statement-breakpoint
-- One row per org: the Workspace of the first connector target (created_at,
-- then id), as the dest Workspace backfill chose it.
INSERT INTO "org_first_workspaces" ("org_id", "workspace_id", "source_repository_id")
SELECT DISTINCT ON (t.org_id)
  t.org_id,
  w."id",
  t.repository_id
FROM (
  SELECT
    r."org_id" AS org_id,
    tmp_normalize_workspace_repository_url(r."git_url") AS git_url,
    r."created_at" AS created_at,
    r."id" AS repository_id
  FROM "confluence_sync_targets" ct
  INNER JOIN "repositories" r
    ON r."id" = ct."repository_id"
    AND r."org_id" = ct."org_id"
  WHERE ct."enabled" IS TRUE
  UNION ALL
  SELECT
    r."org_id",
    tmp_normalize_workspace_repository_url(r."git_url"),
    r."created_at",
    r."id"
  FROM "connections" c
  INNER JOIN "repositories" r
    ON r."org_id" = c."org_id"
    AND r."id" = (c."config"->>'repositoryId')
  WHERE c."type" IN ('linear', 'notion', 'slack')
    AND (c."config"->>'enabled')::boolean IS TRUE
    AND nullif(btrim(c."config"->>'repositoryId'), '') IS NOT NULL
) t
INNER JOIN "workspaces" w
  ON w."org_id" = t.org_id
  AND w."workspace_repository_url" = t.git_url
WHERE t.git_url <> ''
ORDER BY t.org_id, t.created_at, t.repository_id
ON CONFLICT ("org_id") DO NOTHING;
--> statement-breakpoint
DROP FUNCTION tmp_normalize_workspace_repository_url(text);
--> statement-breakpoint
-- Give each OAuth client registered before the MCP scopes the right to ask
-- for them. The user still chooses ctxpipe:write at consent. A client with
-- NULL scopes already uses the server list, so it needs no change.
UPDATE "oauth_clients"
SET "scopes" = "scopes" || ARRAY(
  SELECT "scope"
  FROM unnest(ARRAY['ctxpipe:read', 'ctxpipe:write']::text[]) AS "scope"
  WHERE NOT ("scope" = ANY ("scopes"))
)
WHERE "scopes" IS NOT NULL
  AND NOT ("scopes" @> ARRAY['ctxpipe:read', 'ctxpipe:write']::text[]);
