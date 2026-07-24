CREATE TABLE "notion_webhook_configs" (
	"id" text PRIMARY KEY,
	"integration_id" text,
	"verification_token" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
