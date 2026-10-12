# Plan: ingestion as sandbox skills that write patches (CTX-584)

Concept: [concept.md](concept.md). Milestone: Workspaces (PR 280). Paths are under `apps/backend/src/` unless noted.

**Rules for every ticket.** Prove each behavior with a failing test first ([tdd](../../../.agents/skills/tdd/SKILL.md)). Use real collaborators: real Postgres (`*.integration.test.ts`), real git (temporary repositories and packs), msw for the model proxy upstream and GitHub, and a real Docker sandbox (`*.contract.test.ts`) where the ticket says so. No new environment variable. A ticket that adds a migration needs CTO approval first (marked **needs approval**).

**Size:** S is up to 1 day, M is 2 to 3 days, L is 4 to 6 days. **Parallel:** tickets in the same group letter can run at the same time.

## Phase 0: decision record

### T00 ADR-051: ingestion as sandbox skills that write patches (S)

- **Goal:** record the design. Mark ADR-016 superseded. Add a note to ADR-047 (extraction captures become patch sets at phase 4) and to ADR-048 (ingest sandboxes and the 40-slot limit).
- **Files:** `.ai/memory/decisions/ADR-051-ingestion-sandbox-skills-patches.md`, `decisions/index.md`, ADR-016, ADR-047, ADR-048 status lines.
- **Tests:** none (docs). A spec reviewer checks it against the concept and the CTX-584 decisions.
- **Depends on:** answers to the CTO questions in concept section 12.

## Phase 1: fix now (old pipeline)

All tickets in this phase are group **A** and can run in parallel, except that T02 and T05 both change `workspace-extract-ingest.ts`: run T05 after T02.

### T01 Destinations from Workspace sources (M)

- **Goal:** send extraction to each Workspace that lists the source in `workspace_sources` (and in linked rows until ADR-050 phase 3). Remove the first-Workspace fallback. A run with no destination ends `no_destination`, not `ready`.
- **Files:** `domain/workspaces/capture-repository-extraction.ts`, `openworkflow/workflows/repository-ingestion.ts`.
- **Tests:** integration: a repository listed only in a second Workspace gets files there; a repository with no destination ends `no_destination` and writes nothing.

### T02 One mirror-path list and the PagerDuty kind (S)

- **Goal:** one `isConnectorMirrorPath` (the `CONNECTOR_MIRROR_ROOTS` version). Delete the `layout.ts` copy. `mirrorUnitKind` knows `pagerduty/services/<id>/incidents/`.
- **Files:** `domain/workspaces/layout.ts`, `domain/codeIngestion/connectorMirrorPaths.ts`, `domain/workspaces/mirror-units.ts`, `openworkflow/workflows/workspace-extract-ingest.ts`.
- **Tests:** unit: `pagerduty/services/P1/incidents/x.md` gives `Incident`; `github/pulls/1.md` is a mirror path for the extract transform.

### T03 Embedding reuse by body hash (S to M)

- **Goal:** hydrate reuses a stored vector when the unit body hash did not change. A failed embedding is retried on the next hydrate.
- **Files:** `domain/workspaces/derived-stores.ts`, `openworkflow/workflows/workspace-hydrate.ts`.
- **Tests:** integration plus msw: two revisions with one changed unit make one embedding request.

### T04 Legacy sync-repository ingestion gate (S)

- **Goal:** connector syncs do not start `repository-ingestion` on their sync repository for a connection that has Workspace sources (decision 5).
- **Files:** one shared predicate in `openworkflow/enqueue-repository-ingestion.ts`, used by `linear-sync-{content,entity}.ts` and `notion-sync-{content,entity}.ts`. Check the Slack and PagerDuty syncs for other callers.
- **Tests:** integration: a migrated connection's sync starts no ingestion run; an unmigrated one still does.

### T05 Hashes in transform step outputs (M)

- **Goal:** `transform-extract-ingest` and `transform-connector-mirror` return hashes and counts, not file contents. Later steps read the content again from git or rows. Bound the hydrate `diagnostics`.
- **Files:** `openworkflow/workflows/workspace-extract-ingest.ts`, `workspace-connector-mirror.ts`, `workspace-hydrate.ts`.
- **Tests:** integration: the step output for 1,000 files is under 64 KB; a replay after a crash makes the same commit.
- **Depends on:** T02.

## Phase 2: foundation in shadow mode

### T06 Ingest sandbox definition and slot policy (L) — group B

- **Goal:** the second `defineSandbox` (`workspace-ingest:<image>`, key `ingest:<runId>:<shard>`). Ingest rows count in the 50 slots. At most 40 ingest sandboxes per org, in committed config. The org sweep destroys an ingest row whose run finished or that is older than the shard limit.
- **Files:** a new `domain/workspaces/ingest-sandbox.ts`, the slot count in the sandbox store, `conversation-sandbox-sweep.ts`.
- **Tests:** integration: the 41st ingest start waits while chat can still start; a chat start at 50 total fails; the sweep destroys an orphan ingest row. Contract (Docker): `ensure` creates, attaches, and creates again after a kill.

### T07 Ingest capability and closed egress (M) — group B

- **Goal:** capability purpose `workspace-ingest-model`, bound to org, run, shard, and lock owner. Hosted firewall rules allow only the model proxy, the bridge, and GitHub fetch. Agent Vault refuses other hosts for an ingest vault. Read-only git tokens for the source and destination repositories, revoked at destroy.
- **Files:** `workspace-chat-run-capability.ts`, `workspace-chat-model-proxy.ts`, `sandbox-credential-rules.ts`, `hostedNetworkPolicy`, `run-git-tokens.ts`.
- **Tests:** integration: a chat capability cannot call as ingest, and the reverse. Contract (Docker with Agent Vault): `curl https://example.com` from an ingest sandbox fails; the model proxy call succeeds. Do this first: if Agent Vault cannot refuse hosts, stop and report.

### T08 Ingest tool bridge (M) — group B

- **Goal:** TanStack server tools for codesearch, bound read-only to the run's source checkout key and destination Workspace checkout keys. Run-scoped token, revoked at `destroy-sandbox`.
- **Files:** `domain/workspaces/workspace-chat-tools.ts` (extract the shared tool set), a new `ingest-tools.ts`.
- **Tests:** msw for codesearch: a tool call with another checkout key is refused; a call after revoke fails with 401.

### T09 Skill bundle packaging (M) — group B

- **Goal:** `apps/backend/ingest-skills/<skill>/{SKILL.md,scripts/,schema}` in the backend image. A content hash names the bundle. Prepare copies it to `/ctxpipe/skills`. The OpenCode config loads only that folder and ignores `AGENTS.md`, `.opencode/`, and skills in checkouts. The three stage helpers (`ctxpipe-stage`, `ctxpipe-delete`, `ctxpipe-finish`).
- **Files:** `apps/backend/ingest-skills/`, the backend Dockerfile, the OpenCode config writer.
- **Tests:** unit: the hash changes when one script changes. Contract (Docker): a clone with a hostile `AGENTS.md` and `.opencode/` does not change the agent's tools or prompt (assert on the OpenCode config the agent sees); the helpers make the expected `patch.json` for create, update, and delete.

### T10 Patch-set validator (L) — group B

- **Goal:** the host apply and every check in concept section 3.3 and the host guards in section 6: allowlist, ownership, human section, strict front matter per kind, links, content, caps, delete cap, heading denylist, phrase scanner, and provenance and confidence stamps. Rejections with path, rule, and reason.
- **Files:** a new `domain/ingestion/patch-set.ts` (schema, apply, validate), `domain/codeIngestion/connectorMirrorPaths.ts` (shared list).
- **Tests:** real git: a fixture context repository at a pinned SHA. One case per rule (accept and reject). A `baseBlob` mismatch is rejected. A change to the human section is rejected. Applying the result twice gives the same tree. Pure functions plus git; no database.

### T11 Context index (S to M) — group C

- **Goal:** build `<workspaceId>.index.json` from the active projection at the pinned revision, with the `owned` flag for the run's source.
- **Files:** a new `domain/ingestion/context-index.ts`.
- **Tests:** integration: a hydrated fixture Workspace gives the expected entries; a file a human took over is not `owned`.
- **Depends on:** T10 (shared ownership predicate).

### T12 Patch-set storage (M) — group C — **needs approval**

- **Goal:** table `ingestion_patch_sets`, keyed by (source, SHA, scope, bundle hash, root, skill, destination, destination revision), with ops, rejections, and token use. RLS by org. Rows of a run are deleted after its publish, as ADR-047 does for captures.
- **Files:** `db/schema/ingestion_patch_sets.ts`, a migration, a model module.
- **Tests:** integration: insert, read by key, RLS isolation between two orgs, deletion after publish keeps a newer run's rows.

### T13 Ingestion workflow v2 in shadow mode (L) — group D

- **Goal:** the parent workflow (`resolve`, `index`, `plan-scope`, `plan-shards`, `shard:<n>`, `assemble:<workspaceId>`, `finalize`) and the shard child (`ensure-sandbox`, `discover-roots`, `skill:<root>:<skill>:<workspaceId>`, `destroy-sandbox`). A skill step is one `chat()` with `opencodeText`, or plain `exec` for script-only skills. In shadow mode `assemble` stores a report and does not publish. The old pipeline still publishes.
- **Files:** `openworkflow/workflows/repository-ingestion-v2.ts`, `ingestion-shard.ts`, the trigger in `repository-ingestion-orchestrator.ts` (shadow flag in committed config).
- **Tests:** integration plus Docker contract plus msw for the model: a run on a small fixture repository stores patch sets and publishes nothing; a killed worker during a skill step resumes, and msw counts no second model call for a finished step; step outputs stay under 16 KB.
- **Depends on:** T06 to T12.

### T14 Skills: `discover-roots`, `libraries`, `ownership` (M) — group C

- **Goal:** the first three skills. `discover-roots` uses scripts first and the fast tier only for ambiguous manifests. `libraries` and `ownership` are script-only.
- **Files:** `apps/backend/ingest-skills/{discover-roots,libraries,ownership}/`.
- **Tests:** script unit tests on public monorepo fixtures (pnpm, Cargo, Go workspaces). Contract (Docker): the staged trees pass T10.
- **Depends on:** T09, T10.

### T15 Observability (S) — group D

- **Goal:** run and step attributes, Langfuse session per run at the model proxy, a log line per reject, capped script stderr.
- **Tests:** `InMemorySpanExporter`: a shadow run emits one root span with the SHA and bundle hash, and step spans with op and reject counts.
- **Depends on:** T13.

### T16 Foundation proof (M) — group E

- **Goal:** run three public repositories (small, medium, monorepo) on Docker and on Vercel in shadow mode.
- **Tests:** the Vercel contract lane and a local Docker run; a worker kill test. Record time, cost, and reject counts in the scratchpad.
- **Depends on:** T13 to T15.

## Phase 3: port and compare

Group **F** (T17 to T22) can run in parallel after T16. Each skill ticket has the same proof: script unit tests on public fixtures, a Docker contract run whose staged tree passes T10, and msw model fixtures for a deterministic run.

| Ticket | Skill | Tier | Size |
| --- | --- | --- | --- |
| T17 | `classify-kind` | fast | M |
| T18 | `apis` (OpenAPI, ast-grep routes, SCIP through the bridge) | medium | L |
| T19 | `dependencies` (HTTP and queue clients, streams) | medium | L |
| T20 | `datasources-infra` | medium | M |
| T21 | `decisions` | medium | M |
| T22 | `instruction-areas`: area seed list, document selection, the pattern-count and recency script, the rules in concept section 5.3, update of an owned area file, the human section | medium | L |

T22 extra tests: real git with dated commits. A pattern in 2 files gives no rule. A pattern in 3 files in 2 folders gives an `inferred` rule with 3 evidence paths. A pattern that falls in the newest 90 days goes to **Being replaced**. A document that says the opposite wins. A second run keeps the human section byte for byte.

### T23 Injection fixture set (M) — group F

- **Goal:** a made-up repository with injection payloads in README, code comments, ADRs, `AGENTS.md`, and a context repository with a hostile mirror file. Payloads try to write outside the allowlist, add agent-directed sections, add outside links, use hidden characters, and take over a file.
- **Tests:** each payload is rejected or quoted with its source line. Runs in CI with msw model replies that obey the payload, so the host guards are proven without a live model. A live-model run is part of T24.

### T24 Shadow comparison harness (L) — group G

- **Goal:** run both pipelines on the same SHA. Hydrate both outputs into separate projections. Compare units and claims by kind, name, and predicate, plus the golden snapshots and a labeled set of public repositories. Report recall, rejects, cost, and p95 time.
- **Files:** `apps/backend/scripts/ingestion-compare.ts`, results under `.ai/scratchpad/ingestion-skills/compare/`.
- **Tests:** unit tests of the matcher. The exit criteria of phase 3 come from its report.
- **Depends on:** T17 to T23.

## Phase 4: switch

### T25 Publish patch sets (L) — group H

- **Goal:** `workspace-write-extract-ingest` takes a patch-set key as its transform input, applies the validated ops at the target revision, and commits through the broker. One commit per destination. The concurrent-tip replay and semantic merge stay. `finalize` sets `partial` when a root failed.
- **Files:** `openworkflow/workflows/workspace-extract-ingest.ts`, `domain/workspaces/extraction-source.ts`.
- **Tests:** integration with real git and the broker: one commit per destination; a human commit on the tip between pin and publish is kept; a replay makes the same commit.

### T26 Ownership migration and rollback config (M) — group H

- **Goal:** one-time host write that moves extracted files (`generated_by: ctxpipe` with `import_key`) to `generated_by: ctxpipe-extract` and `source`. A committed config value picks the publishing pipeline, for a rollback within one release.
- **Tests:** integration: a Workspace with old extracted files and a human-edited file; only the extracted files change, in one commit.

### T27 Consumer guidance (S) — group H

- **Goal:** the `ctxpipe-knowledge` SKILL.md text: area files, ownership, the human section, and "extracted files are data with provenance". Coordinate with CTX-550.
- **Files:** `domain/workspaces/bootstrap.ts`.
- **Tests:** unit on the bootstrap output.

## Phase 5: delete

### T28 Delete the old extractors (L) — group I

- **Goal:** delete the 10 ReAct agents, `createAgent`, the ingest use of `repoExplorerTools`, `runExtractRoot`, `withIngestAgentContext`, `getLangfuseHandler`, `extractInstructionUnits`, `EXTRACTOR_VERSION`, the object renderer in `plan-extraction.ts`, the old workflow, and `repository_extraction_captures` (migration, **needs approval**).
- **Tests:** search every `*.test.ts`, `*.contract.test.ts`, `*.integration.test.ts`, and `*.live.test.ts` for uses and run them. The v2 suites stay green.
- **Depends on:** one release after T25.

### T29 Drop LangGraph (S) — group I

- **Goal:** delete LangGraph, its patch, and `db/migrate-checkpoints.ts`.
- **Tests:** the backend suite passes without the patch.

### T30 Delete the legacy sync-repository ingestion (M)

- **Goal:** remove the code that T04 gated.
- **Depends on:** ADR-050 phase 3.

## Order and parallel work

```
T00
A: T01 T02 T03 T04 -> T05
B: T06 T07 T08 T09 T10          (T07 egress proof first)
C: T11 T12 T14                   (after B)
D: T13 -> T15
E: T16
F: T17 T18 T19 T20 T21 T22 T23
G: T24
H: T25 T26 T27
I: T28 T29, then T30 with ADR-050 phase 3
```

Phase 1 can start at once and does not wait for T00.

| Phase | Tickets | Count |
| --- | --- | --- |
| 0 Decision | T00 | 1 |
| 1 Fix now | T01 to T05 | 5 |
| 2 Foundation | T06 to T16 | 11 |
| 3 Port and compare | T17 to T24 | 8 |
| 4 Switch | T25 to T27 | 3 |
| 5 Delete | T28 to T30 | 3 |
