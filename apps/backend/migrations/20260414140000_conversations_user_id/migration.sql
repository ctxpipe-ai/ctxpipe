-- Scope conversations to the owning user (org + user), not org-wide.
ALTER TABLE "conversations" ADD COLUMN "user_id" text;
--> statement-breakpoint
-- Backfill only when the org has a single member (unambiguous owner).
UPDATE "conversations" AS c
SET "user_id" = s."user_id"
FROM (
  SELECT "organization_id", MIN("user_id") AS "user_id"
  FROM "members"
  GROUP BY "organization_id"
  HAVING COUNT(*) = 1
) AS s
WHERE c."org_id" = s."organization_id"
  AND c."user_id" IS NULL;
--> statement-breakpoint
-- Drop legacy rows we cannot assign to one user (prevents cross-user visibility).
DELETE FROM "conversations" WHERE "user_id" IS NULL;
--> statement-breakpoint
ALTER TABLE "conversations" ALTER COLUMN "user_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
DROP INDEX IF EXISTS "conversations_org_id_last_message_at_index";
--> statement-breakpoint
DROP INDEX IF EXISTS "conversations_org_id_source_index";
--> statement-breakpoint
DROP INDEX IF EXISTS "conversations_org_id_updated_at_index";
--> statement-breakpoint
CREATE INDEX "conversations_org_id_user_id_last_message_at_index" ON "conversations" ("org_id", "user_id", "last_message_at");
--> statement-breakpoint
CREATE INDEX "conversations_org_id_user_id_source_index" ON "conversations" ("org_id", "user_id", "source");
--> statement-breakpoint
CREATE INDEX "conversations_org_id_user_id_updated_at_index" ON "conversations" ("org_id", "user_id", "updated_at");
