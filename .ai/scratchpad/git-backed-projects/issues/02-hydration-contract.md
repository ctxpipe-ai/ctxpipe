# Git-canonical knowledge and deterministic hydrate

Type: grilling
Status: open
Blocked by: 01

## Question

What does **fully hydrate from git without invoking any LLM** mean, store by store — including deletion, idempotency, and failure?

Today: git is source + connector mirrors; Postgres objects/claims/evidence (with embeddings) are canonical semantic knowledge; FalkorDB is derived from Postgres; Zoekt/SCIP are derived from a checkout; conversations live in LangGraph checkpoints.

New rule: portable semantic knowledge is git-backed. Database content for that knowledge updates **only** from the project repository.

Settle:

- Which artefacts **must** live in git? (claims, objects, evidence, connector mirrors, project settings — **not** blindly "everything in the organisation")
- Which artefacts are **derived** and rebuilt on hydrate? Embeddings, FalkorDB, Zoekt, SCIP — each yes/no.
- Is an **embedding model** call during hydrate allowed, or does "no LLM" ban every model call?
- Byte-identical Postgres rows (stable ids in front matter) vs "same graph of facts"?
- After hydrate, is Postgres a serving cache, or do runtime reads hit git files?
- Deleted files in git: corresponding DB rows/graph edges must go. How, and is hydrate atomic (replace a revision) or patchy?
- Malformed files: refuse the import, skip the file, or fail the Project?
- Stable-id collisions across files or across Projects.
- Idempotency: hydrate of the same git SHA twice is a no-op.
- Which Postgres tables stay **operational** (auth, connections secrets, OpenWorkflow, conversations) and are **not** git-canonical?

Recommend: git holds reviewable facts with stable ids; hydrate rebuilds the serving stores without extractors; embeddings/Zoekt/SCIP stay derived. Confirm or replace, table by table.
