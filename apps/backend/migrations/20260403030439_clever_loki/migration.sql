ALTER TABLE "claim_evidence" ADD COLUMN "logical_source_key" text;--> statement-breakpoint
CREATE INDEX "claim_evidence_logical_source_key_index" ON "claim_evidence" ("logical_source_key");