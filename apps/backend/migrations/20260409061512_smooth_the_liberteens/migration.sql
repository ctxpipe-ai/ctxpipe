CREATE TABLE "onboarding_org_creation_requests" (
	"user_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"organization_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "onboarding_org_creation_requests_user_key_uidx" ON "onboarding_org_creation_requests" ("user_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "onboarding_org_creation_requests_organization_idx" ON "onboarding_org_creation_requests" ("organization_id");--> statement-breakpoint
ALTER TABLE "onboarding_org_creation_requests" ADD CONSTRAINT "onboarding_org_creation_requests_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "onboarding_org_creation_requests" ADD CONSTRAINT "onboarding_org_creation_requests_N8Y0xb2E6XM2_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE SET NULL;