CREATE TABLE "repository_checkouts" (
	"id" text PRIMARY KEY,
	"repository_id" text NOT NULL,
	"ref" text DEFAULT 'main' NOT NULL,
	"commit_sha" text,
	"checkout_key" text NOT NULL,
	"zoekt_repo_id" serial UNIQUE,
	"zoekt_index_fingerprint" text,
	"cgc_index_fingerprint" text,
	"index_fingerprint" text,
	"zoekt_index_ready" boolean DEFAULT false NOT NULL,
	"cgc_index_ready" boolean DEFAULT false NOT NULL,
	"cgc_partial_json" text,
	"last_accessed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "repository_checkouts_repository_id_checkout_key_unique" UNIQUE("repository_id","checkout_key")
);
--> statement-breakpoint
INSERT INTO "repository_checkouts" (
	"id",
	"repository_id",
	"ref",
	"checkout_key",
	"zoekt_repo_id",
	"zoekt_index_ready",
	"cgc_index_ready",
	"created_at",
	"updated_at"
)
SELECT
	gen_random_uuid()::text,
	r."id",
	'main',
	'default',
	r."zoekt_repo_id",
	COALESCE(r."index_ready", false),
	false,
	now(),
	now()
FROM "repositories" r;
--> statement-breakpoint
SELECT setval(
	pg_get_serial_sequence('repository_checkouts', 'zoekt_repo_id'),
	(SELECT COALESCE(MAX("zoekt_repo_id"), 1) FROM "repository_checkouts")
);
--> statement-breakpoint
ALTER TABLE "repositories" DROP CONSTRAINT "repositories_zoekt_repo_id_key";--> statement-breakpoint
ALTER TABLE "repositories" DROP COLUMN "zoekt_repo_id";--> statement-breakpoint
CREATE INDEX "repository_checkouts_repository_id_index" ON "repository_checkouts" ("repository_id");--> statement-breakpoint
ALTER TABLE "repository_checkouts" ADD CONSTRAINT "repository_checkouts_repository_id_repositories_id_fkey" FOREIGN KEY ("repository_id") REFERENCES "repositories"("id") ON DELETE CASCADE;
