# Git-canonical knowledge and deterministic hydrate

Type: grilling
Status: claimed
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

## Partial answer

Human, 2026-08-13, round 1 (Q1 not locked — restated below):

- **Derived stores:** Postgres `objects` / `claims` / `claim_evidence` are a serving projection of git. Embeddings, FalkorDB, Zoekt, and SCIP are derived. FalkorDB stays a projection of hydrated Postgres (`project()`), not a second markdown parser. Zoekt/SCIP index backing + attached checkouts.
- **Embedding during hydrate:** allowed. No chat/extract LLM. Embedding failure does not roll back the graph; embeddings stay stale until retry.
- **Operational (not git-canonical):** auth/sessions, connection secrets/tokens, OpenWorkflow, conversations, onboarding/pending-account, indexing/checkout status. The Project row (`proj_`, org, backing pointer) stays operational **except display name**.
- **Display name:** git-canonical in the **root map file** front matter (human: `agents.md`). Hydrate writes it onto the Project row. Rename is a git commit (or we write that file).
- **Root folder map:** a root file that describes **folders** (not every object/claim) so agents understand the tree with no extra tool/skill. Adding a connector updates that file with the new folder and what it holds. Filename was given as both `agents.md` and `index.md` — still open.
- **External authors:** systems/agents outside ctxpipe must be able to create these files. Identity therefore cannot require a ctxpipe-minted `obj_` in front matter; **path is the identity, or the serving id is derived from path.** Links/paths in files are the relations.
- **Linked repositories (addendum):** the Project’s linked repo set is git-canonical in the backing tree — not only a Postgres association. Interpretation still open (URL list vs vendoring/submodules). Indexing SHAs, clone credentials, and `proj_` ↔ backing pointer stay operational: we still need the backing remote to *find* the tree. Unlinked repos are those not declared in any Project’s backing tree (and not used as backing).

Q1 was asked in today’s table language (`objects` / `claims` / `evidence`). That confused the destination. Round 2 restates it as a file-native model. Folder taxonomy and markdown syntax remain [Knowledge Markdown and front-matter layout](03-knowledge-file-layout.md).
