CREATE TABLE "oauth_grant_organizations" (
	"grant_id" text,
	"api_key_id" text,
	"organization_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "oauth_grant_organizations_one_owner" CHECK (num_nonnulls("grant_id", "api_key_id") = 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "oauth_grant_organizations_grant_org_uidx" ON "oauth_grant_organizations" ("grant_id","organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "oauth_grant_organizations_api_key_org_uidx" ON "oauth_grant_organizations" ("api_key_id","organization_id");--> statement-breakpoint
CREATE INDEX "oauth_grant_organizations_organization_id_idx" ON "oauth_grant_organizations" ("organization_id");--> statement-breakpoint
ALTER TABLE "oauth_grant_organizations" ADD CONSTRAINT "oauth_grant_organizations_api_key_id_apikeys_id_fkey" FOREIGN KEY ("api_key_id") REFERENCES "apikeys"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "oauth_grant_organizations" ADD CONSTRAINT "oauth_grant_organizations_organization_id_organizations_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;