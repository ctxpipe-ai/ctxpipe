CREATE TABLE "org_member_preferences" (
	"user_id" text,
	"org_id" text,
	"last_used_workspace_id" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "org_member_preferences_pkey" PRIMARY KEY("user_id","org_id")
);
--> statement-breakpoint
CREATE TABLE "workspace_linked_repositories" (
	"id" text PRIMARY KEY,
	"workspace_id" text NOT NULL,
	"git_url" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_linked_repositories_workspace_id_git_url_uidx" UNIQUE("workspace_id","git_url")
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" text PRIMARY KEY,
	"org_id" text NOT NULL,
	"slug" text NOT NULL,
	"display_name" text NOT NULL,
	"workspace_repository_url" text NOT NULL,
	"github_connection_id" text,
	"read_only_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspaces_org_id_slug_uidx" UNIQUE("org_id","slug"),
	CONSTRAINT "workspaces_org_id_repository_url_uidx" UNIQUE("org_id","workspace_repository_url")
);
--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "workspace_id" text;--> statement-breakpoint
ALTER TABLE "conversations" ALTER COLUMN "name" SET DEFAULT 'New conversation';--> statement-breakpoint
CREATE INDEX "conversations_org_id_workspace_id_user_id_last_message_at_index" ON "conversations" ("org_id","workspace_id","user_id","last_message_at");--> statement-breakpoint
CREATE INDEX "workspace_linked_repositories_workspace_id_idx" ON "workspace_linked_repositories" ("workspace_id");--> statement-breakpoint
CREATE INDEX "workspaces_org_id_idx" ON "workspaces" ("org_id");--> statement-breakpoint
ALTER TABLE "org_member_preferences" ADD CONSTRAINT "org_member_preferences_gzcoBbyuxOLm_fkey" FOREIGN KEY ("last_used_workspace_id") REFERENCES "workspaces"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "workspace_linked_repositories" ADD CONSTRAINT "workspace_linked_repositories_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_github_connection_id_connections_id_fkey" FOREIGN KEY ("github_connection_id") REFERENCES "connections"("id") ON DELETE SET NULL;