ALTER TABLE "claim_evidence" ADD COLUMN "org_id" text;--> statement-breakpoint
ALTER TABLE "repository_checkouts" ADD COLUMN "org_id" text;--> statement-breakpoint
CREATE INDEX "claim_evidence_org_id_index" ON "claim_evidence" ("org_id");--> statement-breakpoint
CREATE INDEX "repository_checkouts_org_id_index" ON "repository_checkouts" ("org_id");