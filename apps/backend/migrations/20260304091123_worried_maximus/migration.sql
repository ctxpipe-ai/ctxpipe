ALTER TABLE "conversations" ALTER COLUMN "source" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "conversations" ALTER COLUMN "source" DROP NOT NULL;