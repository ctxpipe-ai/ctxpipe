CREATE TABLE "org_features" (
	"organization_id" text,
	"feature" text,
	"value" text NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "org_features_pkey" PRIMARY KEY("organization_id","feature")
);
--> statement-breakpoint
ALTER TABLE "org_features" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "org_features" ADD CONSTRAINT "org_features_organization_id_organizations_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
CREATE POLICY "org_isolation" ON "org_features" AS PERMISSIVE FOR ALL TO public USING ("org_features"."organization_id" = current_setting('app.organization_id', true)) WITH CHECK ("org_features"."organization_id" = current_setting('app.organization_id', true));