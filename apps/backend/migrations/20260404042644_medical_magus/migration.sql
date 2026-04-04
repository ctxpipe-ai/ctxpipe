CREATE TABLE "org_onboarding" (
	"organization_id" text PRIMARY KEY,
	"completed_at" timestamp,
	"completed_by_user_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP TABLE "confluence_space_page_selections";--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "onboarding_completed_at" timestamp;--> statement-breakpoint
ALTER TABLE "org_onboarding" ADD CONSTRAINT "org_onboarding_organization_id_organizations_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "org_onboarding" ADD CONSTRAINT "org_onboarding_completed_by_user_id_users_id_fkey" FOREIGN KEY ("completed_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL;