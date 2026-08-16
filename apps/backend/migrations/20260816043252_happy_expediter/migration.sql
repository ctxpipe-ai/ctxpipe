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
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_knowledge_units_workspace_id_path_uidx" UNIQUE("workspace_id","path")
);
--> statement-breakpoint
CREATE INDEX "workspace_knowledge_units_workspace_id_idx" ON "workspace_knowledge_units" ("workspace_id");--> statement-breakpoint
CREATE INDEX "workspace_knowledge_units_org_id_idx" ON "workspace_knowledge_units" ("org_id");--> statement-breakpoint
ALTER TABLE "workspace_knowledge_units" ADD CONSTRAINT "workspace_knowledge_units_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;