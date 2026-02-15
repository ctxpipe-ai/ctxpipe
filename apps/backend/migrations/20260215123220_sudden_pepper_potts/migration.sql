CREATE TABLE "repositories" (
	"id" text PRIMARY KEY,
	"org_id" text NOT NULL,
	"zoekt_repo_id" serial UNIQUE,
	"name" text,
	"slug" text,
	"git_url" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
