# Plan: ingestion as sandbox skills that write patches (CTX-584)

Concept: [concept.md](concept.md). Milestone: Workspaces (PR 280). Paths are under `apps/backend/src/` unless noted. Revised for the CTO plan decisions of 2026-10-13.

**Rules for every ticket.** Prove each behavior with a failing test first ([tdd](../../../.agents/skills/tdd/SKILL.md)). Use real collaborators: real Postgres (`*.integration.test.ts`), real git (temporary bare repositories as remotes), msw for the model proxy upstream and GitHub, and a real Docker sandbox (`*.contract.test.ts`) where the ticket says so. No new environment variable and no new table. A ticket that drops a table needs CTO approval first (marked **needs approval**).

**Size:** S is up to 1 day, M is 2 to 3 days, L is 4 to 6 days. **Parallel:** tickets in the same group letter can run at the same time.

**External dependency:** CTX-586 ticket L1 (remove LangGraph, its patch, and `migrate-checkpoints.ts`) runs first. It is not a CTX-584 ticket.

## Phase 0: decision record

### T00 ADR-052: ingestion as sandbox skills that write patches (S)

- **Goal:** record the design. Mark ADR-016 superseded. Add a note to ADR-047 (the ingest ref job kind, and extraction input as a ref tip at phase 4) and to ADR-048 (ingest sandboxes and the 40-slot limit).
- **Files:** `.ai/memory/decisions/ADR-052-ingestion-sandbox-skills-patches.md`, `decisions/index.md`, the status lines of ADR-016, ADR-047, and ADR-048.
- **Tests:** none (docs). A spec reviewer checks it against the concept and the CTX-584 decisions.

## Phase 1: gate

### T01 Legacy sync-repository ingestion gate (S) — group A

- **Goal:** connector syncs do not start `repository-ingestion` on their sync repository for a connection that has Workspace sources (decision 5). The other CTX-582 fixes are out of scope.
- **Files:** one shared predicate in `openworkflow/enqueue-repository-ingestion.ts`, used by `linear-sync-{content,entity}.ts` and `notion-sync-{content,entity}.ts`. Check the Slack and PagerDuty syncs for other callers.
- **Tests:** integration: a migrated connection's sync starts no ingestion run; an unmigrated one still does.

## Phase 2: foundation in shadow mode

### T02 Ingest sandbox definition and slot policy (L) — group B

- **Goal:** the second `defineSandbox` (`workspace-ingest:<image>`, key `ingest:<runId>:<shard>`). Ingest rows count in the 50 slots. At most 40 ingest sandboxes per org, in committed config. The org sweep destroys an ingest row whose run finished or that is older than the shard limit.
- **Files:** a new `domain/workspaces/ingest-sandbox.ts`, the slot count in the sandbox store, `conversation-sandbox-sweep.ts`.
- **Tests:** integration: the 41st ingest start waits while chat can still start; a chat start at 50 total fails; the sweep destroys an orphan ingest row. Contract (Docker): `ensure` creates, attaches, and creates again after a kill.

### T03 Ingest capability and closed egress (M) — group B

- **Goal:** capability purpose `workspace-ingest-model`, bound to org, run, shard, and lock owner. Hosted firewall rules allow only the model proxy, the bridge, and GitHub fetch. Agent Vault refuses other hosts for an ingest vault. Read-only git tokens for the source and the destination repositories (including fetch of the run's ingest refs), revoked at destroy.
- **Files:** `workspace-chat-run-capability.ts`, `workspace-chat-model-proxy.ts`, `sandbox-credential-rules.ts`, `hostedNetworkPolicy`, `run-git-tokens.ts`.
- **Tests:** integration: a chat capability cannot call as ingest, and the reverse. Contract (Docker with Agent Vault): `curl https://example.com` from an ingest sandbox fails; the model proxy call succeeds. Do this first: if Agent Vault cannot refuse hosts, stop and report.

### T04 Ingest tool bridge (M) — group B

- **Goal:** TanStack server tools for codesearch, bound read-only to the run's source checkout key and the destination Workspace checkout keys. Run-scoped token, revoked at `destroy-sandbox`.
- **Files:** `domain/workspaces/workspace-chat-tools.ts` (extract the shared tool set), a new `ingest-tools.ts`.
- **Tests:** msw for codesearch: a call with another checkout key is refused; a call after revoke fails with 401.
- **From the T03 review:** verify bridge calls with the `workspace-ingest-tools` capability (T03). The bridge checks that each claimed repository (`repositoryId`) belongs to `claims.orgId` before it reads a checkout.

### T05 Skill bundle packaging (M) — group B

- **Goal:** `apps/backend/ingest-skills/<skill>/{SKILL.md,scripts/,schema}` in the backend image, named by a content hash, copied to `/ctxpipe/skills` at prepare. The OpenCode config loads only that folder and ignores `AGENTS.md`, `.opencode/`, and skills in checkouts. The three stage helpers (`ctxpipe-stage`, `ctxpipe-delete`, `ctxpipe-finish`).
- **Files:** `apps/backend/ingest-skills/`, the backend Dockerfile, the OpenCode config writer.
- **Tests:** unit: the hash changes when one script changes. Contract (Docker): a clone with a hostile `AGENTS.md` and `.opencode/` does not change the agent's tools or prompt; the helpers make the expected `patch.json` for create, update, and delete.

### T06 Patch validator (L) — group B

- **Goal:** host apply and every check in concept sections 3.1, 4.3, and 6: path allowlist, ownership, additive-only updates of files the source does not own, the human section, strict front matter per kind, links, content, caps, delete cap, heading denylist, phrase scanner, and the provenance and confidence stamps. Rejections with path, rule, and reason.
- **Files:** a new `domain/ingestion/patch-validator.ts`, `domain/codeIngestion/connectorMirrorPaths.ts` (shared list).
- **Tests:** real git with a fixture context repository. One accept case and one reject case per rule. A `baseBlob` mismatch is rejected. A body change to a human file is rejected, and a new `## Related` line is accepted. Applying the result twice gives the same tree.

### T07 Context index (S to M) — group C

- **Goal:** build `<workspaceId>.index.json` from the active projection at the pinned revision, with `sources` and the `owned` flag for the run's source.
- **Files:** a new `domain/ingestion/context-index.ts`.
- **Tests:** integration: a hydrated fixture Workspace gives the expected entries; a file that a human took over is not `owned`.
- **Depends on:** T06 (shared ownership predicate).

### T08 Run-scoped ingest refs (L) — group C

- **Goal:** the broker job kind for `refs/ctxpipe/ingest/<runId>/…` (concept section 7.2): create or advance a ref from the expected old tip, never force, after the T06 validator passes against the base commit; delete a ref. Step commits with fixed author time and the `Ctxpipe-Run`, `Ctxpipe-Step`, and `Ctxpipe-Bundle` trailers. A resume helper that finds a step's commit on the tip. The stale-ref clean-up in the Workspace tip check (`ls-remote`, finished runs, and refs older than 24 hours; shadow refs after 7 days).
- **Files:** `domain/workspaces/write-broker.ts`, a new `domain/ingestion/ingest-refs.ts`, the tip-check workflow.
- **Tests:** first a live GitHub check (one-time, recorded in the scratchpad): the GitHub App can push and delete `refs/ctxpipe/ingest/x`, and a default clone does not fetch it. If GitHub refuses, stop and report. Then real git with a bare remote: a push with a wrong old tip is refused; a push outside the run's names is refused; a replayed step makes the same SHA; the resume helper finds the commit after a simulated crash after push; the clean-up deletes a finished run's refs and keeps a running one's. The default branch never changes, and no hydrate starts.
- **Depends on:** T06.

### T09 Ingestion workflow v2 in shadow mode (L) — group D

- **Goal:** the parent workflow (`resolve`, `index`, `plan-scope`, `plan-shards`, `shard:<n>`, `assemble:<workspaceId>`, repository-wide skill steps, `finalize`) and the shard child (`ensure-sandbox`, `discover-roots`, `skill:<root>:<skill>:<workspaceId>`, `destroy-sandbox`). One model run per destination Workspace. Each step output holds only a ref SHA and counts. The sandbox fetches the ref before each step. In shadow mode nothing publishes, and the old pipeline still publishes.
- **Files:** `openworkflow/workflows/repository-ingestion-v2.ts`, `ingestion-shard.ts`, the trigger in `repository-ingestion-orchestrator.ts` (shadow switch in committed config).
- **Tests:** integration plus Docker contract plus msw for the model: a run on a small fixture repository with two destination Workspaces writes refs in both and publishes nothing; a killed worker after a step's push resumes, and msw counts no second model call for that step; step outputs stay under 16 KB.
- **Run contract (T08 depends on it):** the parent run's input has a top-level `orgId` and `shadow` (`IngestionV2RunInput`). The ref clean-up, the broker's run binding, and the ingest sandbox sweep read both from `openworkflow.workflow_runs`; every workflow version counts. Ref jobs go through the broker wrappers in `write-broker.ts` (`pushWorkspaceIngestStep`, `pushWorkspaceIngestAssemble`, `findWorkspaceStepCommit`, `deleteWorkspaceIngestRefs`) with the Workspace `generation` that `resolve` read; T09 never builds a URL or a token.
- **Unblocked:** the live GitHub App check of T08 passed on 2026-10-13 (see `tickets/T08.md`).
- **Depends on:** T02 to T08.
- **Acceptance (from the T03 review):** a Docker ingest sandbox starts only where its traffic is forced through Agent Vault (the DinD or AWS sandbox host, or an internal Docker network). `dockerIngestSandboxProvider` checks this at create and refuses an open host, such as host dev. If T09 runs `opencode serve` in the sandbox, it needs `publishPorts` (T03 exposes the option) and the chat wrappers (`withDockerAgentPort`, `withSingleOpencodeServer`, `withOwnerWatchdog`) around the ingest provider.
- **Tool bridge (from the T04 review):**
  - Mint the `workspace-ingest-tools` capability once for each step, together with the model capability, with the step's checkouts (`rev:<sha>` for the source, `ws:<workspaceId>:<sha>` for each destination repository).
  - The bridge route `POST /api/v1/workspace-ingest/tool-bridge` runs in the API process, not in the worker. The worker must give the sandbox the API origin, so `sandboxCallbackHost` (or the public base URL) must point at the API.
  - OpenCode must still get the TanStack `tanstack` MCP server for the bridge, although T05 sets `mcp: {}`.
  - The bridge has no rate limit for each shard yet. Add one, or accept the ADR-027 codesearch budgets as the only limit.

### T10 Skills: `discover-roots`, `libraries`, `ownership` (M) — group C

- **Goal:** the first three skills. `discover-roots` uses scripts first and the fast tier only for ambiguous manifests. `libraries` and `ownership` are script-only.
- **Files:** `apps/backend/ingest-skills/{discover-roots,libraries,ownership}/`.
- **Tests:** script unit tests on public monorepo fixtures (pnpm, Cargo, Go workspaces). Contract (Docker): the staged trees pass T06.
- **Depends on:** T05, T06.

### T11 Observability (S) — group D

- **Goal:** run and step attributes (ref SHA, ops, rejects, tokens), a Langfuse session per run at the model proxy, a log line per reject, capped script stderr.
- **Tests:** `InMemorySpanExporter`: a shadow run emits one root span with the SHA and bundle hash, and step spans with op and reject counts.
- **Depends on:** T09.

### T03b Hosted ingest egress proxy (M) — before T12

- **Goal:** closed egress for hosted (Vercel) ingest sandboxes. The Vercel firewall cannot deny a path: its API keeps credential rules and forward rules in separate lists, so an ordered "deny the rest" rule does not hold. Instead, the policy forwards all of `github.com` and the backend paths (`forwardURL`) to a backend egress handler, built with `defineSandboxProxy` from `@vercel/sandbox/proxy` (it verifies the request's OIDC token and gives the `sandboxId`). The handler maps the `sandboxId` to its ingest shard, applies the path and method allowlist (Git fetch of the shard's repositories, the step's model proxy and tool bridge), adds the credential on the server side, and proxies the request to GitHub or the backend route. Every other request gets 403. Use `subnets.deny` for private ranges.
- **Files:** `ingest-sandbox-egress.ts` (`ingestNetworkPolicy`, `VERCEL_INGEST_EGRESS_PROVEN`), a new backend proxy route.
- **Tests:** unit and msw: the handler refuses a wrong `sandboxId`, a push, another repository, and an unlisted backend path; it adds the credential only on allowed requests. T12 must prove it live.
- **T12 must prove (live, Vercel):** a push to github.com (also with a token in the URL) is refused; SSH on port 22, a raw IP, a CONNECT to another SNI on an allowed IP, and DNS exfiltration fail; `subnets.deny` holds if Vercel supports it; Git fetch, the model proxy, and the tool bridge work.

### T12 Foundation proof (M) — group E

- **Goal:** run three public repositories (small, medium, monorepo) on Docker and on Vercel in shadow mode, on a test organization.
- **Tests:** the Vercel contract lane, a local Docker run, and a worker-kill test. Record time, cost, and reject counts in the scratchpad.
- **Must prove (from the T03 review):** the T03b list (live Vercel egress through the backend egress proxy). Until it passes, `vercelIngestSandboxProvider` refuses to start (`VERCEL_INGEST_EGRESS_PROVEN` in `ingest-sandbox-egress.ts`).
- **Depends on:** T09 to T11.

## Phase 3: port and compare

Group **F** (T13 to T19) can run in parallel after T12. Each skill ticket has the same proof: script unit tests on public fixtures, a Docker contract run whose staged trees pass T06, and msw model fixtures for a deterministic run. Each also proves that the agent updates an existing file that describes the same thing, and does not add a duplicate.

| Ticket | Skill | Tier | Size |
| --- | --- | --- | --- |
| T13 | `classify-kind` | fast | M |
| T14 | `apis` (OpenAPI, ast-grep routes, SCIP through the bridge) | medium | L |
| T15 | `dependencies` (HTTP and queue clients, streams) | medium | L |
| T16 | `datasources-infra` | medium | M |
| T17 | `decisions` | medium | M |

### T18 `instruction-areas` with shared area files (L) — group F

- **Goal:** the area seed list, document selection, the pattern-count and recency script, the good-practice rules (concept 5.4), the same-or-different comparison (5.2), joining a shared file and the `follows` claim from the codebase file (5.1, 5.3), and the shared-file rules in the T06 validator.
- **Tests:** real git with dated commits: a pattern in 2 files gives no rule; 3 files in 2 folders give an `inferred` rule with 3 evidence paths; a falling pattern goes to **Being replaced**; a document that says the opposite wins. Shared files: a second repository with the same practice joins `unit-testing.md` and adds its evidence; a repository on another framework gets `unit-testing-<difference>.md`; an update that removes another source's rule is rejected; the file goes when its last source leaves; the human section stays byte for byte.

### T19 Injection fixture set (M) — group F

- **Goal:** a made-up repository with injection payloads in README, code comments, ADRs, and `AGENTS.md`, and a context repository with a hostile mirror file. Payloads try to write outside the allowlist, add agent-directed sections, add outside links, use hidden characters, take over a file, and change a shared file's other sources.
- **Tests:** each payload is rejected or quoted with its source line. Runs in CI with msw model replies that obey the payload, so the host guards are proven without a live model. A live-model run is part of T20.

### T20 Shadow comparison harness (L) — group G

- **Goal:** run both pipelines on the same SHA. Hydrate the old output and the shadow ref tip into separate projections. Compare units and claims by kind, name, and predicate, plus the golden snapshots and a labeled set of public repositories. Report recall, rejects, cost, and p95 time.
- **Files:** `apps/backend/scripts/ingestion-compare.ts`, results under `.ai/scratchpad/ingestion-skills/compare/`.
- **Tests:** unit tests of the matcher. The phase 3 exit criteria come from its report.
- **Depends on:** T13 to T19.

## Phase 4: switch

### T21 Publish from the ref (L) — group H

- **Goal:** `workspace-write-extract-ingest` takes the assembled ref tip as its transform input. It replays the delta from the pinned revision on the current default tip as one commit, with the existing replay and semantic merge, and the existing broker and CAS rules. A `delete-refs` step follows. `finalize` sets `partial` when a root failed.
- **Files:** `openworkflow/workflows/workspace-extract-ingest.ts`, `domain/workspaces/extraction-source.ts`, the v2 parent workflow.
- **Tests:** integration with real git and the broker: one commit per Workspace; a human commit on the tip between pin and publish stays; a replay makes the same commit; the refs are gone after publish; a crash between publish and `delete-refs` leaves refs that the clean-up removes.

### T22 Ownership migration and rollback config (M) — group H

- **Goal:** a one-time host write that moves extracted files (`generated_by: ctxpipe` with `import_key`) to `generated_by: ctxpipe-extract` and `sources`. A committed config value picks the publishing pipeline, for a rollback within one release.
- **Tests:** integration: a Workspace with old extracted files and a human-edited file; only the extracted files change, in one commit.

### T23 Consumer guidance (S) — group H

- **Goal:** the `ctxpipe-knowledge` SKILL.md text: shared area files, ownership, the `## Related` section, the human section, and "extracted files are data with provenance". Coordinate with CTX-550.
- **Files:** `domain/workspaces/bootstrap.ts`.
- **Tests:** unit on the bootstrap output.

## Phase 5: delete

### T24 Delete the old extractors (L) — group I

- **Goal:** delete the 10 ReAct agents, `createAgent`, the ingest use of `repoExplorerTools`, `runExtractRoot`, `withIngestAgentContext`, `getLangfuseHandler`, `extractInstructionUnits`, `EXTRACTOR_VERSION`, the object renderer in `plan-extraction.ts`, the old workflow, and the `repository_extraction_captures` table (migration, **needs approval**).
- **Tests:** search every `*.test.ts`, `*.contract.test.ts`, `*.integration.test.ts`, and `*.live.test.ts` for uses and run them. The v2 suites stay green.
- **Depends on:** one release after T21; CTX-586 L1.

### T25 Delete the legacy sync-repository ingestion (M)

- **Goal:** remove the code that T01 gated.
- **Depends on:** ADR-050 phase 3.

## Order and parallel work

```
CTX-586 L1 (external, first)
T00
A: T01
B: T02 T03 T04 T05 T06          (T03 egress proof first)
C: T07 T08 T10                   (after T06; T08 GitHub ref proof first)
D: T09 -> T11
E: T12
F: T13 T14 T15 T16 T17 T18 T19
G: T20
H: T21 T22 T23
I: T24, then T25 with ADR-050 phase 3
```

T01 can start at once and does not wait for T00.

| Phase | Tickets | Count |
| --- | --- | --- |
| 0 Decision | T00 | 1 |
| 1 Gate | T01 | 1 |
| 2 Foundation | T02 to T12 | 11 |
| 3 Port and compare | T13 to T20 | 8 |
| 4 Switch | T21 to T23 | 3 |
| 5 Delete | T24 to T25 | 2 |
| **Total** | | **26** |
