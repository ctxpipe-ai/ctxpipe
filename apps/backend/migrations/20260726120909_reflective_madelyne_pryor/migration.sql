ALTER TABLE "repositories" ADD COLUMN "last_ingested_at" timestamp with time zone;
--> statement-breakpoint
UPDATE "repositories"
SET "last_ingested_at" = "updated_at"
WHERE "last_ingested_hash" IS NOT NULL;