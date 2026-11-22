CREATE TABLE "oauth_client_assertions" (
	"id" text PRIMARY KEY,
	"expires_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_client_resources" (
	"id" text PRIMARY KEY,
	"client_id" text NOT NULL,
	"resource_id" text NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "oauth_resources" (
	"id" text PRIMARY KEY,
	"identifier" text NOT NULL UNIQUE,
	"name" text NOT NULL,
	"access_token_ttl" integer,
	"refresh_token_ttl" integer,
	"signing_algorithm" text,
	"signing_key_id" text,
	"allowed_scopes" text[],
	"custom_claims" jsonb,
	"dpop_bound_access_tokens_required" boolean DEFAULT false,
	"disabled" boolean DEFAULT false,
	"created_at" timestamp,
	"updated_at" timestamp,
	"policy_version" integer DEFAULT 1,
	"metadata" jsonb
);
--> statement-breakpoint
ALTER TABLE "jwkss" ADD COLUMN "alg" text;--> statement-breakpoint
ALTER TABLE "jwkss" ADD COLUMN "crv" text;--> statement-breakpoint
ALTER TABLE "oauth_access_tokens" ADD COLUMN "authorization_code_id" text;--> statement-breakpoint
ALTER TABLE "oauth_access_tokens" ADD COLUMN "resources" text[];--> statement-breakpoint
ALTER TABLE "oauth_access_tokens" ADD COLUMN "requested_user_info_claims" text[];--> statement-breakpoint
ALTER TABLE "oauth_access_tokens" ADD COLUMN "revoked" timestamp;--> statement-breakpoint
ALTER TABLE "oauth_access_tokens" ADD COLUMN "confirmation" jsonb;--> statement-breakpoint
ALTER TABLE "oauth_clients" ADD COLUMN "client_discovery_id" text;--> statement-breakpoint
ALTER TABLE "oauth_clients" ADD COLUMN "subject_type" text;--> statement-breakpoint
ALTER TABLE "oauth_clients" ADD COLUMN "client_credentials_scopes" text[] DEFAULT '{}'::text[];--> statement-breakpoint
ALTER TABLE "oauth_clients" ADD COLUMN "backchannel_logout_uri" text;--> statement-breakpoint
ALTER TABLE "oauth_clients" ADD COLUMN "backchannel_logout_session_required" boolean;--> statement-breakpoint
ALTER TABLE "oauth_clients" ADD COLUMN "application_type" text;--> statement-breakpoint
ALTER TABLE "oauth_clients" ADD COLUMN "jwks" text;--> statement-breakpoint
ALTER TABLE "oauth_clients" ADD COLUMN "jwks_uri" text;--> statement-breakpoint
ALTER TABLE "oauth_clients" ADD COLUMN "require_pkce" boolean;--> statement-breakpoint
ALTER TABLE "oauth_clients" ADD COLUMN "dpop_bound_access_tokens" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "oauth_consents" ADD COLUMN "resources" text[];--> statement-breakpoint
ALTER TABLE "oauth_consents" ADD COLUMN "requested_user_info_claims" text[];--> statement-breakpoint
ALTER TABLE "oauth_refresh_tokens" ADD COLUMN "authorization_code_id" text;--> statement-breakpoint
ALTER TABLE "oauth_refresh_tokens" ADD COLUMN "resources" text[];--> statement-breakpoint
ALTER TABLE "oauth_refresh_tokens" ADD COLUMN "requested_user_info_claims" text[];--> statement-breakpoint
ALTER TABLE "oauth_refresh_tokens" ADD COLUMN "rotated_at" timestamp;--> statement-breakpoint
ALTER TABLE "oauth_refresh_tokens" ADD COLUMN "rotation_replay_response" text;--> statement-breakpoint
ALTER TABLE "oauth_refresh_tokens" ADD COLUMN "rotation_replay_expires_at" timestamp;--> statement-breakpoint
ALTER TABLE "oauth_refresh_tokens" ADD COLUMN "confirmation" jsonb;--> statement-breakpoint
CREATE UNIQUE INDEX "oauthClientResources_clientId_resourceId_uidx" ON "oauth_client_resources" ("client_id","resource_id");--> statement-breakpoint
CREATE INDEX "oauthClientResources_resourceId_idx" ON "oauth_client_resources" ("resource_id");--> statement-breakpoint
ALTER TABLE "oauth_client_resources" ADD CONSTRAINT "oauth_client_resources_client_id_oauth_clients_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "oauth_clients"("client_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "oauth_client_resources" ADD CONSTRAINT "oauth_client_resources_CxFm94nYigrM_fkey" FOREIGN KEY ("resource_id") REFERENCES "oauth_resources"("identifier") ON DELETE CASCADE;