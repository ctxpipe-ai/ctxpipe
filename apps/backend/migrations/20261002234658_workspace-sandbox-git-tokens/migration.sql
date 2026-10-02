CREATE TABLE "workspace_sandbox_git_tokens" (
	"sandbox_id" text PRIMARY KEY,
	"org_id" text NOT NULL,
	"token_ciphertext" text NOT NULL,
	"minted_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workspace_sandbox_git_tokens" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "org_isolation" ON "workspace_sandbox_git_tokens" AS PERMISSIVE FOR ALL TO public USING ("workspace_sandbox_git_tokens"."org_id" = current_setting('app.organization_id', true)) WITH CHECK ("workspace_sandbox_git_tokens"."org_id" = current_setting('app.organization_id', true));