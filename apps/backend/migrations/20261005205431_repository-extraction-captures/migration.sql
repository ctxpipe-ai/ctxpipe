CREATE TABLE "repository_extraction_captures" (
	"org_id" text NOT NULL,
	"repository_id" text,
	"source_sha" text,
	"scope" text,
	"extractor_version" integer,
	"root" text,
	"part" integer,
	"objects" jsonb NOT NULL,
	"claims" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "repository_extraction_captures_pkey" PRIMARY KEY("repository_id","source_sha","scope","extractor_version","root","part")
);
--> statement-breakpoint
ALTER TABLE "repository_extraction_captures" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "repository_extraction_captures_org_id_idx" ON "repository_extraction_captures" ("org_id");--> statement-breakpoint
ALTER TABLE "repository_extraction_captures" ADD CONSTRAINT "repository_extraction_captures_64ScVXTtwZsy_fkey" FOREIGN KEY ("repository_id") REFERENCES "repositories"("id") ON DELETE CASCADE;--> statement-breakpoint
CREATE POLICY "org_isolation" ON "repository_extraction_captures" AS PERMISSIVE FOR ALL TO public USING ("repository_extraction_captures"."org_id" = current_setting('app.organization_id', true)) WITH CHECK ("repository_extraction_captures"."org_id" = current_setting('app.organization_id', true));