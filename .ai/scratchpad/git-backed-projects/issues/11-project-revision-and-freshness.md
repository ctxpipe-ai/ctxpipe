# Project revision and derived-store freshness

Type: grilling
Status: open
Blocked by: 08, 10

## Question

How do we know a checkout, a hydrate, and a codesearch index are on the revision we intend — **without** a git remote round-trip on the hot path?

A **single stored hash cannot** stand for all of: git HEAD on the hosting remote, last **successfully hydrated** revision, last **successfully indexed** (Zoekt/SCIP) revision. Human pushes to the default branch also do not appear in our DB unless a webhook (or similar) records them.

Today: `repository_checkouts.commit_sha` is the indexed checkout; `repositories.last_ingested_hash` is set when knowledge ingestion finishes; index phases `git fetch` / `git ls-remote`.

The brief: repositories scoped to Projects; on access, compare against a **commit hash in the database**; if instance A already ingested, instance B pulls, instance A is a no-op.

Settle:

- Distinct fields: desired/remote tip (from webhook), hydrated SHA, indexed SHA — which exist?
- Who writes each (ingest hydrate, webhook, codesearch phase)?
- What "access" means: search, file get, sandbox start, hydrate, all of these?
- Mismatch behaviour: pull that SHA (git operation, but not `ls-remote`); if DB hash is missing?
- Webhook loss: how we reconcile without putting `ls-remote` on every request (periodic? on ingest? never?)
- JWT / search filter: mandatory project scope, not optional org-wide repo lists.
- Failure transitions: hydrate succeeded but index failed, and the reverse.
- Shared attach: two Projects may attach the same git URL for search ([Project identity and invariants](18-project-identity-and-invariants.md)). **Locked by hydrate Q17: indexes are independent per Project** — one Zoekt clone / `repository_checkouts` row **per Project**, not shared. Do not re-grill sharing. Settle only the per-Project revision fields.
- **`repositories/*.md` `branch`:** front-matter branch is the **desired ref** to clone/index. Merging the file **authorizes clone** (hydrate Q16); GitHub authz may still reject; UI shows a human-friendly clone error. Settle how desired ref relates to webhook tip / indexed SHA when HEAD moved.

Recommend explicit revision fields per store, compared locally, pull only on mismatch. Do not collapse them into one SHA unless you can show they cannot diverge.
