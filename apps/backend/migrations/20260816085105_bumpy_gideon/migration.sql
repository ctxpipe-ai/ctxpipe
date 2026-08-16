CREATE TABLE "org_workspace_cutover" (
	"org_id" text PRIMARY KEY,
	"first_workspace_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "last_branch" text;--> statement-breakpoint
ALTER TABLE "workspace_knowledge_units" ADD COLUMN "embedding" jsonb;