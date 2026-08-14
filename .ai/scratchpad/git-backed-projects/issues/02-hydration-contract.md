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

## Draft answer (reopened)

Sol (`gpt-5.6-sol-xhigh`) refused close-out: retry vs same-SHA no-op contradiction; overstated atomicity; markdown-link semantics; skip-malformed vs replace-SHA data loss; org-scoped serving rows; `AGENTS.md` / `repositories/` ownership; rename detection is heuristic; clone-from-git-declaration is a security hole. Round 3 below. Do not treat this draft as locked.

Human, 2026-08-13 (rounds 1–2, still in force except where round 3 replaces): **Git-canonical knowledge is the files in the backing tree**, not an export of today’s `objects` / `claims` / `claim_evidence` tables. Serving stores are a projection of one git SHA. Hydrate never runs an extract/chat LLM.

**Round 3 (human, 2026-08-13):**

- **Q11 success line:** activating the **Project-scoped Postgres projection** is hydrate success. Embeddings / Falkor / Zoekt / SCIP have their own status. Same-SHA no-op applies only to phases that already succeeded; failed embeddings stay retryable.
- **Q12 serving graph (round 4):** two layers are **permanent**. Layer 1: markdown links → `LINKS_TO`. Layer 2: optional `claims:` (predicate, confidence, temporality). Hydrate never infers from prose. A **write-path maintenance job** upgrades layer 1 → layer 2 (generate claim + relation), repairs, improves, and **commits**. Trigger/commit shape is [Ingest-to-git write and concurrency protocol](10-ingest-to-git-write-protocol.md).
- **Q18 confidence:** the number in the file is the **maximum** (authoritative ceiling) for that signal. Hydrate copies it. **Recall** weakens it using temporality (old high-confidence → weak-ish). Combining/recall formula still open.
- **Q19 temporality:** ingest/hydrate **copy** `valid_from` / `valid_to` from the file (missing both = evergreen).
- **Q22 `valid_from` backfill:** maintenance job **fills only if missing**, from the git commit that **introduced** the claim. Bump `valid_from` only when the job **re-asserts** the claim. Not on no-op maintenance commits.
- **Q20 same edge, many files:** **merge** confidences; more corroborating signals **increase** overall confidence. Must be **deterministic** at hydrate/recall (no LLM). Today’s `aggregateConfidence` is a weighted **mean** and does **not** increase with extra agreeing 0.8s. Combining rule still open.
- **Q13 malformed:** skip **any** malformed file, including `AGENTS.md` and `repositories/*.md`. Hydrate still activates. Malformed `AGENTS.md`: **do not** update the Project display name (keep last known / repo-name default). Malformed `repositories/*.md`: **remove that attach** for this SHA (unlink), record error. Missing `AGENTS.md` is the same as malformed for the name (don’t update).
- **Q14 `AGENTS.md` ownership:** keep the filename. Ops agent may edit **front matter `name`** and a **marked folder-map section** only. Never the rest of the file. Foreign `repositories/` content is not overwritten; layout ticket names any fallback path.
- **Q15 rename:** repair **as much as possible**. Reference rewrites may be their **own commit** (not only ctxpipe-authored same-commit moves). Hydrate stays read-only; dangling links until that commit are skipped edges.
- **Q16 clone authority:** a merged `repositories/*.md` **does authorize clone**. Remotes may be outside the org. GitHub integration / authz **rejects** if not permitted. UI shows a human-friendly clone-failure indicator. Description **body is optional**. No secrets in git.
- **Q17 scope:** all knowledge is **Project-scoped**. Serving rows, relations, activation, deletion are per Project. **Index infrastructure is independent per Project** (no shared Zoekt clone across Projects, even for the same git URL). Only **integrations / auth** are shared (many-to-many), with multiple source→destination mappings.

**Damped combine + window/source decay remain (Q21/Q23).** Do not resolve until those land.

**Files are the units; path is identity; links are relations.** (Rounds 1–2; round 3 supersedes malformed / idempotency / rename / clone / scope where they disagree.)

- A markdown (or already-mirrored connector) file is a knowledge unit. Foreign agents create files without a ctxpipe-minted `obj_`. Serving ids, if Postgres still uses prefixed keys, are a **pure function of Project + path**.
- **Links/paths inside files are relations.** Hydrate materializes serving edges from those references. A claim does not have to be its own file.
- Object / claim / evidence remain **serving-store words**, not authoring words.

**Root folder map: `AGENTS.md`.**

- Lives at the backing repo root. Describes **folders** (not every unit) so an agent understands the tree with no extra tool or skill.
- **Display name** is git-canonical in this file’s front matter. Hydrate copies it onto the `proj_` row. Rename is a git change.
- When **our** operations add or change a folder (new connector, first `repositories/` tree, …), a **TanStack AI `chat()` agent with no sandbox and no harness** updates `AGENTS.md`. Do not blindly append — the file may already list folders or hold customer instructions. `withSandbox` / `opencodeText` stay **client project-chat only**.
- **Hydrate does not call a chat LLM and does not rewrite `AGENTS.md`.** If the map is stale relative to folders, hydrate still projects the files that exist; a later ops agent pass can repair the map.

**Linked repositories: `repositories/*.md`.**

- One markdown file per attached remote. Front matter holds **git URL, branch, and similar clone fields**. Body is a description of what is in that repo so an external agent can decide whether to explore it with no extra tools.
- Not submodules, not a bare URL list. Codesearch still clones the remotes named in front matter.
- The **backing** remote is this repo (implicit) and is described in `AGENTS.md`, not duplicated as a self-URL under `repositories/` unless a later layout ticket says otherwise.
- Duplicate git URLs in two files: treat the extras as **malformed** (skip; keep the first path in tree order). Indexing SHAs, clone credentials, and `proj_` ↔ backing pointer stay **operational**. Unlinked = not used as backing and not named in any Project’s `repositories/` tree.

**Derived stores (hydrate rebuilds, no extractors).**

- Postgres `objects` / `claims` / `claim_evidence`: serving projection of the tree at the hydrated SHA. Runtime reads hit Postgres, not git files on the hot path.
- Embeddings: derived. Hydrate **may** call the embedding API. If it fails, the graph still goes live; embeddings stay stale until retry.
- FalkorDB: derived from hydrated Postgres via existing `project()`. Not a second markdown parser.
- Zoekt / SCIP: derived from backing + attached checkouts.

**Operational (never git-canonical):** auth/sessions, connection secrets/tokens, OpenWorkflow/job state, conversations, onboarding/pending-account, indexing and checkout status.

**Rename / move.**

- Path identity: move/rename is a **new id**. Old serving row and edges go away.
- When git **detects** a rename, **rewrite all previous references** in other files so links do not stay broken. That rewrite is a **git commit on the write path** ([Ingest-to-git write and concurrency protocol](10-ingest-to-git-write-protocol.md)), not hydrate. Hydrate is read-only on the tree and must not invent link targets git does not contain. Until the rewrite commit exists, leftover links to the old path are ordinary missing refs (skip / no edge).

**Replace one SHA; skip junk; same SHA is a no-op.**

- Hydrate **replaces this Project’s knowledge at one git SHA**. Previous SHA stays live until the new hydrate succeeds. Deleted files drop serving rows and edges. Attached codesearch indexes are not wiped by a knowledge hydrate (they have their own index SHA).
- **Malformed files / idempotency:** superseded by round 3 Q11 and Q13.

Folder taxonomy beyond `AGENTS.md`, `repositories/`, and existing connector trees, plus front-matter keys and example files, are [Knowledge Markdown and front-matter layout](03-knowledge-file-layout.md). Desired ref vs indexed SHA for `repositories/*.md` `branch` is [Project revision and derived-store freshness](11-project-revision-and-freshness.md). Auto-attach on migration must **commit** `repositories/*.md` (and ops-update `AGENTS.md` if the folder is new) — [First-project migration and idempotent cutover](12-first-project-migration.md).

## Comments

- 2026-08-13 — Round 1 locked derived/operational stores and embedding-during-hydrate; Q1 restated as file-native.
- 2026-08-13 — Round 2: file-native yes; `AGENTS.md` + TanStack ops agent (no sandbox); rename is new id plus write-path ref rewrite; SHA replace / skip malformed / no-op confirmed; linked repos are `repositories/*.md` with URL+branch front matter and a description body.
- 2026-08-13 — Closed too early; Sol refused. Reopened for a third grilling round. File-native / `AGENTS.md` / `repositories/*.md` / unsandboxed ops agent remain the human’s round-2 intent until round 3 says otherwise.
- 2026-08-13 — Round 3 locked Q11, Q13–Q17 (skip-all-malformed; clone-from-declaration; independent indexes; repair-refs in own commit). Q12 + confidence/temporality still open.
- 2026-08-13 — Round 5: Q22 fill-if-missing `valid_from` locked. Noisy-OR too steep at 0.8+0.8=0.96; want dampening and/or lower author scores. Decay must use `valid_to` (long window = slower); evergreen uses **source-based** half-life, not a global 90 days. Ingest/skill should write stronger `valid_to`.
