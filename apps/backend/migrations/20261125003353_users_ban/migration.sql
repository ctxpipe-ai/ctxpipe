CREATE TABLE "org_api_key_creators" (
	"api_key_id" text PRIMARY KEY,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_token_cutoffs" (
	"user_id" text PRIMARY KEY,
	"revoked_before" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "banned" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "ban_reason" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "ban_expires" timestamp;--> statement-breakpoint
CREATE INDEX "org_api_key_creators_user_id_idx" ON "org_api_key_creators" ("user_id");--> statement-breakpoint
ALTER TABLE "org_api_key_creators" ADD CONSTRAINT "org_api_key_creators_api_key_id_apikeys_id_fkey" FOREIGN KEY ("api_key_id") REFERENCES "apikeys"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "org_api_key_creators" ADD CONSTRAINT "org_api_key_creators_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "user_token_cutoffs" ADD CONSTRAINT "user_token_cutoffs_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;