CREATE TABLE IF NOT EXISTS "github_installations" (
	"id" text PRIMARY KEY,
	"installation_id" integer NOT NULL,
	"ingest_all_repositories" boolean DEFAULT false NOT NULL,
	"include_future_repos" boolean DEFAULT false NOT NULL,
	"org_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "github_installations_org_id_installation_id_unique" UNIQUE("org_id","installation_id")
);
--> statement-breakpoint
ALTER TABLE "repositories" ADD COLUMN "github_installation_id" text;--> statement-breakpoint
ALTER TABLE "repositories" ADD CONSTRAINT "repositories_EVGqN6DVQ2Er_fkey" FOREIGN KEY ("github_installation_id") REFERENCES "github_installations"("id") ON DELETE SET NULL;--> statement-breakpoint