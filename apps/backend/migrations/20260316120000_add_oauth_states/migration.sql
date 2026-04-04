CREATE TABLE "oauth_states" (
	"id" text PRIMARY KEY,
	"connector_id" text NOT NULL,
	"org_id" text NOT NULL,
	"org_slug" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
