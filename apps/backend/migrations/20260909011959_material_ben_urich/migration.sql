CREATE TABLE "sandbox_locks" (
	"org_id" text,
	"key" text,
	"owner" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "sandbox_locks_pkey" PRIMARY KEY("org_id","key")
);
--> statement-breakpoint
ALTER TABLE "sandbox_locks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "sandbox_locks" ADD CONSTRAINT "sandbox_locks_org_id_organizations_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
CREATE POLICY "org_isolation" ON "sandbox_locks" AS PERMISSIVE FOR ALL TO public USING ("sandbox_locks"."org_id" = current_setting('app.organization_id', true)) WITH CHECK ("sandbox_locks"."org_id" = current_setting('app.organization_id', true));