ALTER TABLE "two_factors" ADD COLUMN "verified" boolean DEFAULT true;--> statement-breakpoint
ALTER TABLE "two_factors" ADD COLUMN "failed_verification_count" integer DEFAULT 0;--> statement-breakpoint
ALTER TABLE "two_factors" ADD COLUMN "locked_until" timestamp;--> statement-breakpoint
UPDATE "two_factors" t SET "verified" = false FROM "users" u WHERE t."user_id" = u."id" AND u."two_factor_enabled" IS NOT TRUE;