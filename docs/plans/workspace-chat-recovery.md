# Git-backed Workspaces recovery plan

## Correction and audit boundary

The first version used `296c386..1fad841`. The cloud checkout was shallow
and treated `296c386` as a parentless graft from the middle of PR 280, producing
only 114 commits and 318 files. Those figures never described the full PR.

The local recovery fetched full history and reconciled GitHub metadata with
native git: **465 commits, 801 files, +148,441/−13,326**, from merge base
`9072089086f6fad87fbf05572b9f1ff5336e0520` to PR head
`1fad8412525efdeefdfa4899fe9a2f41dfbbc1c8`.
The [Gate 0 bundle](workspace-recovery-gate-0/baseline.md) contains the full file
manifest and archived primary-source metadata. Its inventory is taken from
tracked files at the PR head; dependency installations and generated output do
not change the inventory.

The plan considers the entire repository tree, all 19 Git-backed
Workspaces design tickets, accepted PRDs and ADRs, and runtime, test, CI,
migration, and deployment paths. Complete-history access is restored; Gate 0
remains in progress until runtime evidence, test classification, and independent
review are complete. See [current status](workspace-recovery-gate-0-status.md).

## Executive diagnosis

PR 280 attempted several architecture changes at once:

- Make git files canonical Workspace knowledge.
- Add Workspace identity, repository lifecycle, and first-Workspace migration.
- Build deterministic hydrate and multiple derived projections.
- Move connector ingestion onto git-writing jobs.
- Add job and chat sandbox lifecycles across several providers.
- Replace product chat with TanStack + OpenCode.
- Add editable conversation files, diffs, branch push, and PR creation.
- Replace the main product information architecture and navigation.

Those are coupled by revision identity, authorization, GitHub credentials,
sandbox ownership, persistence, and UI state. They were implemented horizontally
and then stabilized with local adapters, process caches, polling, catch-and-empty
fallbacks, and tests that mock the neighboring layer. The result has many tests
and much code, but no single proof that the core user journey works.

The recovery direction is **not another rewrite across all layers** and not a
provider-neutral framework. It is a sequence of vertical slices that make the
chosen foundations authoritative:

1. Native git owns repository, revision, branch, diff, and worktree semantics.
2. OpenWorkflow owns durable job orchestration, retry, and resumption.
3. Stock TanStack AI owns chat, persistence middleware, stream lifecycle, and
   OpenCode sandbox integration.
4. Pierre owns file-tree and diff/editor interaction primitives.
5. ctxpipe code owns only product policy: organisation authorization, Workspace
   identity, projection activation, credential brokering, and publish rules.

Every slice first establishes an external behavioral oracle, routes product policy
directly through those native interfaces, and deletes competing machinery. No
phase is done if it wraps a selected library in a lookalike generic abstraction or
adds a new owner beside the old one.

## Foundation bets and abstraction budget

The earlier plan over-corrected toward custom interfaces such as
`WorkspaceJobRunner`, `SandboxLeaseStore`, `ChatEngine`, and a broad
`ConversationSession`. Those names risk hiding the exact libraries we intend to
bet on and recreating their contracts. This revision makes the following choices
explicit.

### TanStack AI + OpenCode sandbox are the chat architecture

Use the stock path from ADR-030 directly:

```text
useChat({ persistence: true })
↕ official WebSocket stream / reconstructChat
chat({ middleware: [withPersistence, withSandbox] })
↕
opencodeText
```

`defineSandbox`, its lifecycle (`reuse: "thread"`, `snapshot: "after-setup"`),
the TanStack instance store, and official persistence are the seams. Do not build
another session engine, event lifecycle, persistence journal, provider registry,
or OpenCode process manager around them. ctxpipe code may authenticate the route,
resolve immutable Workspace input, supply tools, broker credentials, and translate
product-specific errors. If TanStack lacks a required capability, first prove the
gap with a package contract test and contribute or upgrade upstream; a local
adapter must be narrow, temporary, and carry a deletion condition.

### OpenWorkflow is the job runner

Do not build a generic `WorkspaceJobRunner` that duplicates queueing, retry,
checkpoint, cancellation, or recovery. Each product job is an OpenWorkflow
workflow with typed input and a small number of durable steps. Native workflow
identity and attempts are the operational source of truth. Domain functions used
inside a step may be pure, but orchestration remains visible in the workflow.

### Native git is the repository and worktree interface

Do not invent repository, branch, diff, status, commit, or worktree models that
shadow git. Use real repositories and native commands with explicit refs and
object IDs. Small functions may enforce path safety, authentication, and product
policy, but return git facts rather than a parallel mutable state model. Postgres
stores only operational pointers and projection state that cannot be recovered
cheaply from git; it does not mirror dirtiness, diffs, or branch truth.

### Pierre is the Files/Diff UI

Use `@pierre/trees` and `@pierre/diffs` directly for tree state, git badges,
selection, editing, and diffs as ADR-026 requires. Do not wrap Pierre in a generic
file-browser design system or rebuild its state machine in React. A thin
Workspace pane binds server data and authorized commands to Pierre and applies
house theming; Pierre owns the interaction primitive.

### What deserves a ctxpipe module

A custom module is justified only where product policy exists and the chosen
foundation does not own it. Good seams are narrow functions or value types for:

- Resolving an authorised `WorkspaceRevision`.
- Transactionally activating a Workspace projection.
- Brokering a session-branch push or pull request without exposing credentials.
- Mapping an authenticated Hono request to TanStack chat input.
- Mapping native git/Pierre events to an authorized file command.

Apply the deletion test: if removing a proposed module merely exposes an existing
TanStack, OpenWorkflow, git, or Pierre interface, delete the module and use the
foundation directly.

## Current-system inventory

### Backend

The current `apps/backend/src/domain/workspaces` tree alone contains roughly 64
production modules / 12,323 lines and 68 test modules / 13,194 lines. Related
Workspace routes, models, schemas, and workflows add approximately 9,089 more
production lines. The backend Workspace implementation therefore exceeds 21,400
production lines before shared GitHub, retrieval, auth, and workflow code.

High-concentration files include:

- `migration-export.ts` — 843 lines.
- `tanstack-workspace-chat.ts` — 816 lines.
- `write-job-agent.ts` — 555 lines.
- `workspace-chat-tools.ts` — 522 lines.
- `sandbox-registry.ts` — 475 lines.
- `workspace-chat-persistence.ts` — 390 lines.
- `hydrate.ts` — 376 lines.
- `job-sandbox.ts` — 372 lines.

The domain exposes hundreds of symbols across lifecycle, revision, hydrate, job,
sandbox, file, chat, and publish helpers. Callers must understand too much of the
implementation, so changes produce shotgun surgery instead of locality.

### UI

The current Home, chat, and Workspace product path contains roughly 9,345 lines
across 53 production files, plus 2,312 test lines, 3,252 Storybook lines, a
1,263-line fixture, and 529 lines of mock Workspace handlers.

The largest production concentrations are:

- `WorkspacePane.tsx` — 1,720 lines.
- `queries.ts` — 740 lines.
- `WorkspaceSurface.tsx` — 505 lines.
- `WorkspaceChatSession.tsx` — 434 lines.
- `WorkspaceFileTree.tsx` — 429 lines.
- `ConversationThread.tsx` — 390 lines.

The UI is not just rendering server state. It independently coordinates
conversation IDs, preparation, socket warming, auto-send, streaming, route
commitment, drafts, sandbox readiness, polling, editor saves, diffs, push, and PR
creation.

### Tests and CI

The repository contains approximately 343 test files and 2,042 test declarations:

| Area | Test files | Test declarations | `vi.mock` calls |
| --- | ---: | ---: | ---: |
| Backend | 235 | 1,456 | 489 |
| UI | 61 | 282 | 32 |
| Codesearch | 33 | 181 | 21 |
| CLI | 10 | 95 | 0 |
| AWS CDK | 4 | 28 | 0 |

The Workspace UI slice has 19 test files and about 89 declarations, but uses 12
static SSR renders, zero mounted DOM renders, and zero `userEvent` calls. Quantity
is not the limiting factor; the suite is pointed at the wrong seams.

## The system we are recovering

The resolved design tickets still provide a coherent destination:

- A Workspace has its own `ws_` identity, exactly one workspace repository, and
  zero or more linked search repositories.
- Git files are canonical. Postgres, graph, embeddings, Zoekt, and SCIP are
  derived, Workspace-scoped projections of an explicit revision.
- Hydrate reads git and updates projections; it does not edit git or invoke an
  extract/chat LLM.
- Jobs make predefined, single-purpose commits to the default branch. A runner,
  not an agent sandbox, owns push credentials.
- Chat uses one sandbox/worktree per conversation and may publish only an
  explicit session branch/PR. It never pushes the default branch.
- A normal first chat answer should complete in about five seconds.
- The UI is Workspace-centered: conversation in the main region, with Files,
  Diff/Graph, and Settings as Workspace-local tools.

The recovery should preserve these product rules while shrinking the machinery
used to enforce them. Where code and these locks disagree, reopen the decision
explicitly rather than adding another compatibility path.

## Where complexity and slowness come from

### 1. Revision identity is represented as loosely coupled fields

Workspace state spans desired URL/generation/SHA, active projection URL/SHA,
indexed SHA, hydrate status/error, and per-phase state. Job, chat, file, search,
and UI callers partially reconstruct what “current” means. This creates legal
type shapes that are operationally contradictory and forces defensive polling.

**Simplification:** introduce one immutable `WorkspaceRevision` value and one
discriminated `ProjectionState`. Do not pass independent strings that callers can
mix across generations.

```ts
type WorkspaceRevision = {
  workspaceId: WorkspaceId
  generation: number
  remote: GitRemote
  defaultBranch: BranchName
  sha: CommitSha
  access: "read" | "publish-session" | "write-default"
}

type ProjectionState =
  | { kind: "absent" }
  | { kind: "building"; desired: WorkspaceRevision }
  | { kind: "active"; revision: WorkspaceRevision; stores: StoreFreshness }
  | { kind: "failed"; desired: WorkspaceRevision; error: ProjectionError }
```

### 2. Hydrate is a workflow plus provider-specific file loop

GitHub hydrate lists the tree and fetches each Markdown file sequentially. A
100-file Workspace can incur roughly 101 provider calls before parsing. Database
activation, embeddings, graph projection, and search indexing then advance in
separate stages with multiple partial-state fields.

**Simplification:** make hydrate four explicit operations:

```text
read one immutable revision
→ parse a complete projection candidate
→ transactionally activate Postgres projection
→ enqueue independent derived-store materialization
```

Read the revision with native git from one authenticated shallow checkout. Avoid
a provider-neutral tree API and avoid one GitHub contents request per file. Tests
use real temporary repositories through the same git commands. Parsing must be
pure. Activation must use one CAS against generation + SHA. Derived stores report
freshness without changing which Postgres projection is active.

### 3. Jobs combine scheduling, agent behavior, git, and push policy

Job intent, write queues, OpenWorkflow, job sandbox ownership, in-sandbox
worktrees, generated changes, commit construction, fast-forward checks, and push
recovery are spread across domain, models, and workflow modules. The broad agent
surface makes deterministic one-purpose jobs look like a generic coding-agent
framework.

**Simplification:** make OpenWorkflow itself the visible runner. Each job kind is
a typed OpenWorkflow workflow with durable steps for acquire revision, run a
pure/deterministic transform, stage with native git, validate, commit, CAS-check,
and broker the push. Do not place those steps behind a second generic runner or
job-state machine. Sandbox code never gets push credentials. Prefer deterministic
transforms for export, mirror update, `valid_from`, and reference repair; invoke an
LLM only where the accepted ticket explicitly requires semantic conflict
resolution.

### 4. Sandbox lifecycle has three sources of truth

Current sandbox identity and ownership live in:

1. A process-local registry map.
2. A second process-local definition/handle memo.
3. Durable `workspace_sandbox_instances` rows.

Files attempt one local handle source and then another. Restart and replica
handoff therefore depend on which cache is warm, despite durable rows suggesting
otherwise. HTTP send, WebSocket send, prepare, and Files warm-up each repeat some
runtime acquisition behavior.

**Simplification:** make TanStack's `defineSandbox` lifecycle and instance-store
contract authoritative for chat sandboxes. Persist only the locator and product
metadata TanStack needs to resume through the official instance store. Provider
selection is configuration supplied to `defineSandbox`, not a ctxpipe lifecycle
framework. Replace the registry, definition memo, route warm-up, and file attach
fallback with direct use of the ensured TanStack sandbox handle; do not introduce
a `SandboxLeaseStore` facade that copies TanStack's methods.

Job sandboxes remain OpenWorkflow-owned resources because they are not chat
threads. Their create/use/destroy operations should be explicit durable workflow
steps using the selected TanStack sandbox provider, not a shared home-grown
registry spanning chat and jobs.

### 5. Chat has multiple lifecycle and protocol owners

HTTP and WebSocket independently build similar runtime callbacks. The central
chat module owns event normalization, assistant-text filtering, persistence
completion, naming, sandbox construction, provider resolution, port leasing,
proxy credentials, retrieval tools, middleware, and disposal. The AG-UI iterator
adds setup/idle/drain timing around TanStack’s own lifecycle.

Before `chat()` begins, a Send may load conversation and Workspace state, reparse
configuration, make three GitHub calls, persist branch state, query sandbox rows,
reconcile providers, dynamically load TanStack modules, rebuild tools, create a
proxy, and ensure a sandbox. Warm prepare repeats much of this without producing
a concrete lease for Send.

**Simplification:** make the stock TanStack chat construction the single chat
path. One small Hono composition function resolves authenticated Workspace input
and calls `chat({ messages, threadId, runId, middleware })`; both HTTP and
WebSocket codecs feed that function. `withPersistence`, `withSandbox`,
`opencodeText`, `toWebSocketStream`, and `reconstructChat` retain their native
contracts. Do not introduce `ConversationSession` or `ChatEngine` facades that
restate them.

Files and publish are adjacent product commands against the ensured sandbox
worktree, not methods added to a broad chat object. Prepare calls the same
`definition.ensure()` used by Send. A warm turn performs zero GitHub calls and no
sandbox-definition rebuild. Retrieval tool definitions are static; data is fetched
only when a tool is invoked.

### 6. Errors are deliberately converted into plausible data

Current paths turn branch lookup failure into “branch absent,” retrieval failure
into no tools, persistence read failure into no messages, file read failure into
not found, non-2xx UI hydration into an empty thread, and unavailable Git status
into an apparently clean tree. These fallbacks obscure outages and weaken every
test oracle.

**Simplification:** use typed errors/results at module interfaces. Empty, missing,
not ready, stale, forbidden, and unavailable are distinct states. Only the view
decides how a failure is presented. Infrastructure adapters must not invent valid
domain data.

### 7. The UI runs a second workflow engine

Home generates a client ID, stores a draft in a module global, fires prepare,
prefetches, and navigates. Workspace chat then reconciles route, compose, and
pending IDs; warms another socket; prepares again; and auto-sends through an
Effect guarded by another module-global set. Refresh or a new tab loses the draft,
while a long session retains sent IDs indefinitely.

Within the mounted session, correctness is split across `useChat`, refs, state,
Query, callbacks, and router timing. A late error can disagree with route/list
commitment. The warmed socket exposes no disposal operation.

**Simplification:** one idempotent server command accepts the first message and
returns the canonical conversation/run identity. Remove pending-compose globals,
sent-ID globals, auto-send Effect, and three-way ID reconciliation. The client
session exposes `connect`, `send`, `stop`, `resume`, and `dispose` through one
state machine.

### 8. Files and publish have duplicate owners and polling

Files tree/status and pane publishing poll at 400 ms, while chat owns another
status observer and duplicate push/PR mutations. One action can trigger serial
invalidations of tree, status, diff, and every blob. The editor owns a ten-second
timer but cleanup cancels rather than flushes it, so navigation can lose changes.
Writes have no explicit base revision, so overlapping responses can apply out of
order.

**Simplification:** expose focused Hono commands backed by the ensured TanStack
sandbox handle and native git (`status --porcelain`, `diff`, `show`, `mv`, `rm`,
`commit`, and explicit session-branch push). Responses carry the current git object
ID or worktree version needed for optimistic concurrency; they do not create a
parallel repository model.

Bind those responses directly into one Pierre tree/diff/editor owner. Delete
independent 400 ms pollers, blanket invalidations, duplicate publish mutations,
and eventually the session-storage tree snapshot. Define editor navigation
behavior explicitly: flush, block with a choice, or retain a durable draft—never
silently discard. Do not add a generic `ConversationWorktree` facade over native
git and Pierre.

## Why existing tests regularly miss issues

### The suite verifies substitute choreography

The main backend chat tests replace TanStack, OpenCode, persistence, sandbox
providers, proxying, database/auth, registry, Workspace models, retrieval, and
embeddings. Route tests replace the domain/model interfaces they should compose.
Implementation and mock can evolve together and remain consistently wrong.

### Temporal failures are tested as static shapes

Recurring faults concern callback ordering, stream completion, disconnect,
resume, process cleanup, concurrent sends, restart, stale handles, and persistence
after terminal events. Most assertions inspect immediate arrays, mock calls, or
configuration objects. Synthetic streams emit the exact expected lifecycle.

### UI tests do not mount the product

Workspace session tests mock `useChat`, transport, navigation, input, and queries,
then render static HTML. Effects, clicks, timers, cleanup, sockets, routing,
streaming rerenders, Query observers, browser storage, and mutation races never
execute. Stories and large fixtures form another internally consistent product
simulation rather than proof of the backend contract.

### Strong tests are optional or excluded

Normal backend tests exclude `*.integration.test.ts`; RLS is separately excluded
from the package command. OpenCode and two-turn suites are conditional. A green
run does not state which owned runtime actually executed. CI has no browser E2E,
does not build the whole changed system, and uses regex-filtered typecheck scripts
that can print errors outside selected paths while exiting successfully.

### Expected failure is diagnosis, not a gate

The hydration test added in the first plan used `it.fails`, allowing known broken
behavior to remain green indefinitely. It has been replaced with an honest
characterization of current behavior: 401/403/500 currently become an empty
thread. Gate 3 must invert that assertion into a normal error contract alongside
the production change. No recovery proof may use `skip`, `fails`, unconditional
`todo`, or retries to manufacture success.

## Test architecture: fewer tests, stronger proof

### Tier 1 — pure invariants

Use small no-mock tests for revision values, state reducers, path safety, event
deduplication, offset rules, confidence/temporal math, and typed error mapping.
These are the only appropriate tests for implementation-level helpers.

### Tier 2 — deep module contracts

- Workspace revision resolution against migrated Postgres and temporary native
  git remotes.
- Hydrate against native git fixture repositories with 0, 1, and 100 files, plus
  real Postgres and substituted external embedding/search services.
- Each OpenWorkflow job against real git/worktrees and a local bare remote.
- TanStack `defineSandbox` lifecycle and instance-store contracts against the real
  local-process provider, with a small provider fake only for failure injection.
- Stock TanStack `chat` + `withPersistence` + `withSandbox` + `opencodeText`
  against a scripted upstream model server.
- File/status/diff/publish Hono commands against a real temporary git repository,
  then Pierre bindings against those wire responses.

Assert returned state, emitted events, commits, durable rows, and resource cleanup;
do not assert calls to private helpers.

### Tier 3 — application/transport contracts

Use the real Hono app, auth fixture, schemas, org authorization, migrated
Postgres, and real application modules. Substitute only third-party network or
provider edges. Exercise equivalent HTTP and WebSocket turns and compare
normalized events plus persisted results. Cover error codes, malformed data,
idempotency, cancellation, disconnect/resume, and duplicate terminal events.

### Tier 4 — Storybook browser interaction tests

Storybook interaction tests running in its Playwright-powered browser are the
primary UI behavior suite. Extend the existing colocated stories with `play`
functions that exercise the real production components, router, Query client,
hooks, transport binding, and Pierre surfaces. MSW substitutes external
HTTP/WebSocket boundaries only. Do not mock owned hooks, queries, input,
navigation, or component implementations.

Cover Home submit through route commit, Strict Mode idempotency, streaming, retry,
stop, reload/reconnect state, edit/save, diff, keyboard/focus behavior, and shared
publish state. Assert visible behavior, navigation, accessibility, cleanup, and
request budgets. Do not add jsdom or happy-dom Vitest component tests; keep Vitest
for pure non-DOM logic.

### Tier 5 — integrated Playwright product journey

Use Playwright with integrated UI/backend, migrated Postgres, controlled git
remote, local sandbox/OpenCode, and scripted model upstream. Prove:

1. Create/open Workspace.
2. Submit from Home exactly once.
3. Observe first text and one terminal event.
4. Reload persisted history.
5. Send a second turn in the same worktree.
6. Edit a file and observe the authoritative tree/diff update.
7. Commit/push session branch and create a PR artifact.
8. Restart backend and resume from durable state.
9. Delete/close and assert no orphan process or lease.

Provider-live tests remain canaries; they do not replace deterministic gates.

## Measurement harness before refactoring

Record cold and warm runs separately. For at least 20 warm and five cold samples,
capture p50/p95/max for:

- Workspace/revision resolution.
- Git provider calls and bytes.
- Hydrate revision read, parse, activation, and each derived store.
- Job queue wait, sandbox acquisition, transform, commit, and push.
- Home submit → accepted conversation and route commitment.
- Send → socket open, first server event, first text, terminal, persistence, and
  cleanup.
- File command → visible tree and diff update.
- Publish request → pushed branch and PR URL.

Also count database queries, GitHub calls, sandbox creates/resumes, OpenCode
processes, open sockets after navigation, requests per active UI over 5/30/60
seconds, and leaked resources. The first warm-turn budget is zero GitHub calls,
at most one lease attach, and no provider creation. The existing accepted target
remains about five seconds for a complete useful first answer.

## Recovery gates and implementation order

### Adversarial review protocol for every gate

Every gate ends with a fresh adversarial review agent using
`gpt-5.6-sol-high`. The implementer does not perform this review. Give the
reviewer:

- The gate's fixed starting commit and proposed ending commit.
- The complete three-dot diff and changed-file list.
- The Gate 0 scope manifest, relevant design tickets, ADRs, and acceptance proof.
- Test, build, measurement, migration, and deletion results.

The reviewer must inspect the repository, not only the supplied diff. It traces
every changed interface to all callers, searches for parallel implementations and
old vocabulary, checks routes/workflows/background processes/UI entry points, and
compares the implementation against both the gate requirements and repository
standards. It must explicitly look for code outside the expected directories so a
path filter or incomplete handoff cannot hide missed work.

The review artifact contains:

1. A requirement-by-requirement pass/fail matrix with file evidence.
2. A codebase-coverage map listing every searched subsystem and entry point.
3. Blocking correctness, security, migration, performance, and test-oracle
   findings.
4. Old owners, compatibility paths, callers, tests, docs, or state that should
   have been removed but remain.
5. Commands and searches used to establish completeness.

A gate passes only after every blocking finding is resolved and the adversarial
agent re-reviews the final commit with no blockers. “Not found” is not sufficient:
the reviewer records where and how it searched. Non-blocking follow-ups need an
owner and a later gate; they cannot silently disappear from the plan.

### Gate checkpoint commits and pushes

Every gate produces a durable checkpoint on the same GitHub branch:
`codex/develop-plan-to-refocus-branch-direction`. The user explicitly approved all pushes to this branch on 2026-09-08; do not
request publication approval again for recovery checkpoints. Do not create a new recovery
branch per gate and do not leave a completed gate only in a local worktree.

Use this completion sequence for Gate 0 through Gate 6:

1. Start from the previous gate's verified remote SHA and record it as the fixed
   review point.
2. Complete the gate implementation and required proof, then commit it with a
   subject beginning `Gate N:`.
3. Push the candidate commit to
   `origin/codex/develop-plan-to-refocus-branch-direction` so the independent
   adversarial agent reviews the exact GitHub commit, not uncommitted state.
4. Resolve every blocker in follow-up commits on that branch and push after each
   correction. Do not force-push while the review is active.
5. Ask the adversarial agent to re-review the final pushed SHA. The gate is not
   complete until it reports no blockers.
6. Record the final local SHA, verified remote SHA, review artifact, proof results,
   measurements, and any owned follow-ups in the gate report. Verify the remote
   branch resolves to the same SHA before beginning the next gate.

The required push command from the recovery worktree is:

```bash
git push origin HEAD:codex/develop-plan-to-refocus-branch-direction
```

If authentication, branch protection, or the remote is unavailable, the gate is
blocked rather than complete. Never report a local commit as a finished gate.

### Gate 0 — restore truthful scope and a reproducible baseline

Live status and resume commands are recorded in
[`workspace-recovery-gate-0-status.md`](workspace-recovery-gate-0-status.md).

1. Fetch PR 280 full ancestry and exact merge base in an authenticated checkout.
2. Record authoritative commit/file/line statistics and changed package list.
3. Run install, full typecheck, all affected builds/tests, migrations, and one
   manual golden journey; archive failures rather than filtering them away.
4. Record current latency, request counts, provider calls, and flake rate.
5. Classify tests as proof, characterization, or redundant.

Exit: one baseline report covers all 465 commits / 801 files and can be reproduced
from a named commit. The evidence checkpoint cd45f598 has passed both exact-remote reviews; see the Gate 0 status report for the terminal handoff.

Adversarial review focus: prove the merge base, head, 801-file manifest, affected
packages, design decisions, migrations, deployment surfaces, and failing baseline
are complete. Reconcile every discrepancy with GitHub's PR totals before Gate 1.

### Gate 1 — make CI truthful without fixing product behavior

1. Replace regex-filtered typechecking with full typecheck or a finite,
   diagnostic-specific allowlist that only shrinks.
2. Add production builds for every affected runnable/package surface.
3. Make required test prerequisites explicit; a missing binary or skipped proof
   fails the job.
4. Add deterministic contract lanes for Postgres, git, local sandbox, hydrate,
   job runner, and chat engine.
5. Reject new `skip`, `fails`, unconditional `todo`, blind retries, and owned
   module mocks in proof tests.

Exit: green means the stated modules really executed. Existing failures may be
temporarily allowlisted, but cannot be hidden by path regex or silent skip.

Adversarial review focus: search every workflow and package script for filtered
diagnostics, implicit skips, retries, missing prerequisites, unbuilt affected
packages, and tests that mock the owned seam they claim to prove.

### Gate 2 — establish one revision and projection model

1. Introduce `WorkspaceRevision` and `ProjectionState` at the current database
   seam, with temporary mappings for existing columns.
2. Resolve the immutable revision in one product-policy function.
3. Acquire the tree with one native git checkout/read path; remove per-file GitHub
   contents calls.
4. Make parsing pure and Postgres activation a single generation/SHA CAS.
5. Express embedding, graph, and search freshness as derived-store results.
6. Route hydrate and search through this value, then delete obsolete field
   reconstruction and provider-specific repository models.

Required proof: same-SHA no-op, rewind, relink/generation race, malformed files,
deletion, 100-file call budget, embedding failure, index failure, and no partially
exposed active revision.

Adversarial review focus: trace every reader and writer of revision, generation,
projection, hydrate, and indexed state across schemas, models, workflows, search,
chat, UI, migrations, and connector paths. Find any surviving per-file provider
loop or caller that can construct a contradictory revision.

### Gate 3 — make job writes a single transactional command

1. Define each typed job as an OpenWorkflow workflow with explicit durable steps.
2. Use native git directly in stage/validate/commit/CAS/push steps; do not add a
   second runner lifecycle.
3. Keep push credentials exclusively in the brokered workflow push step.
4. Replace generic agent paths with deterministic transforms where possible.
5. Prove one-commit semantics, concurrent job conflict, OpenWorkflow retry
   idempotency, protected/default branch rules, and push-uncertainty recovery.
6. Delete superseded write-intent, runner, and duplicate workflow choreography.

Exit: every default-branch change has one typed job, one commit, and one durable
result; no other module can push default.

Adversarial review focus: enumerate every git commit/push and credential issuance
path in the repository, including connectors, migrations, retries, webhooks, and
conversation publishing. Prove OpenWorkflow owns retry/resume and that no sandbox
or alternative runner can push the default branch.

### Gate 4 — unify conversation and sandbox ownership

1. Make TanStack `defineSandbox` plus its Postgres instance store the chat
   sandbox authority; do not introduce another lease abstraction.
2. Add restart and two-replica race tests against that native contract before
   switching callers.
3. Route HTTP and WebSocket through one thin authenticated call to stock TanStack
   `chat`; keep files/publish as focused native-git commands on the ensured handle.
4. Make prepare call the same `definition.ensure()` consumed by Send.
5. Keep `withPersistence`, `withSandbox`, `opencodeText`, `toWebSocketStream`, and
   `reconstructChat` native and remove the parallel lifecycle code around them.
6. Remove GitHub and tool construction from valid warm turns.
7. Delete process registry/definition ownership, duplicate route acquisition,
   manual terminal/persistence repair, and catch-and-empty behavior.

Required proof: two turns, disconnect/resume offsets, process restart, replica
handoff, simultaneous sends, stale credential/revision after prepare, one terminal
event, transcript equality, cleanup, and warm-turn call/latency budget.

Adversarial review focus: trace every chat entry point—HTTP, WebSocket, prepare,
hydrate/reconstruct, MCP compatibility, files, publish, delete, idle cleanup, and
provider resume. Search the full tree for competing registries, handle maps,
custom event lifecycles, persistence repair, OpenCode process management, and
per-turn GitHub work.

### Gate 5 — collapse the UI workflow engine

1. Replace client-generated draft choreography with one idempotent first-message
   server command.
2. Keep `useChat` as the client session owner and add only the missing disposal
   hook to the narrow WebSocket transport binding.
3. Make route/server identity canonical; remove compose/route/pending ID
   reconciliation and render-time state repair.
4. Give working-tree and publish state one owner with versioned commands.
5. Define editor save/navigation semantics and ordered per-file writes.
6. Replace polling/invalidation waterfalls with authoritative updates.
7. Split `WorkspacePane` by real responsibility only after data/workflow ownership
   has moved behind deep interfaces.

Required Storybook interaction proof in the Playwright browser: Strict Mode
single send, late error ordering, socket cleanup, reload/reconnect, rapid route
changes, edit then navigate, out-of-order saves, shared publish pending state,
Pierre keyboard/focus behavior, and a stable-state request budget.

Adversarial review focus: walk every route and entry into Home, Workspace compose,
conversation, Files, Diff, Graph, Settings, push, and PR creation. Inspect stories
and `play` functions as well as production code; find duplicate state owners,
module globals, polling, blanket invalidation, mocked owned components, and custom
tree/diff behavior that bypasses Pierre.

### Gate 6 — gate the complete product and delete scaffolding

1. Make the deterministic Playwright golden journey mandatory.
2. Add codesearch, Storybook/accessibility, docs, migration-upgrade, and CDK gates
   when the full PR diff confirms those surfaces changed.
3. Delete characterization tests once deeper proof owns their invariant.
4. Delete parallel fixtures/mocks no longer needed by stories.
5. Remove compatibility adapters, stale ADR implementation paths, and superseded
   state columns only after migration proof.
6. Compare final LOC, module count, owner count, request count, and latency to Gate
   0—not to the incomplete shallow range.

Exit: one golden journey proves the product, every runtime owner is durable and
singular, and the recovery has a positive deletion ledger.

Adversarial review focus: audit the final repository rather than only Gate 6's
diff. Re-run the scope manifest, dependency/caller searches, all required proof,
migration paths, deployment builds, resource-leak checks, latency budgets, and the
deletion ledger. Confirm docs and ADRs describe the implementation that actually
ships and that no superseded path remains reachable.

## Initial diagnostic backlog—identify before fixing

These are the first tests to implement as ordinary, deterministic checks:

1. Full Hono hydration matrix: valid empty 200, persisted 200, 401, 403, 404,
   409, 500, malformed body, and transient failure preserving displayed history.
2. Home → conversation Storybook interaction test under Strict Mode with exactly
   one prepare, send, route commit, and list insertion.
3. Equivalent HTTP/WebSocket turn contract with identical event/persistence
   result.
4. Stream fault matrix: duplicate/out-of-order/missing terminal, terminal with
   producer still open, abort, disconnect, resume offset, and process exit.
5. Lease restart/handoff/race test with two application instances.
6. Warm prepare → mutate revision/credential → Send stale-definition test.
7. Real-git file matrix: binary, spaces, delete, rename, many files, dirty tree,
   missing remote, failed remote, and version conflict.
8. Storybook editor interaction matrix using browser-controlled time: unmount
   before autosave, blur plus new edit, two files, responses resolved out of
   order, and keyboard save overlapping autosave.
9. Storybook stable-page request budget with chat, Files, Diff, and Publish
   visible.
10. Hydrate 100-file provider-call budget and generation/SHA CAS race.
11. Job concurrency/push-uncertainty test proving one commit and idempotent retry.
12. Deterministic browser golden journey including restart and cleanup.

The current transport characterization records that non-2xx hydration is silently
treated as empty. It intentionally does not fix that behavior. The first backlog
item replaces this narrow characterization with a real application-seam contract,
then production can change with a red-to-green proof.

## Simplification and deletion targets

These targets are guardrails, not architecture-by-line-count:

- One revision type instead of independently combined generation/SHA/URL fields.
- One projection activation interface.
- One default-branch writer: an explicit brokered step in each OpenWorkflow job.
- One chat sandbox lifecycle owner: TanStack `defineSandbox` + instance store.
- One stock TanStack chat construction shared by HTTP and WebSocket codecs.
- One `useChat` state owner and one disposable WebSocket transport binding.
- Native git owns worktree truth; one Pierre binding owns its UI presentation.
- Zero infrastructure-error-to-empty conversions.
- Zero independent 400 ms steady-state pollers.
- Zero process-global correctness stores.
- Zero push credentials in an agent sandbox.
- Reduce relevant UI production code by 30–40%; bring `WorkspacePane.tsx` below
  roughly 500 composition-focused lines.
- Delete an estimated 550–750 backend lines when registry/memo/duplicate attach
  paths are replaced, then continue deleting orchestration from chat and jobs.
- Every recovery PR must delete or name the exact subsequent deletion it unlocks.

## Iteration contract

Every recovery PR answers:

1. Which external behavior is newly proven?
2. Which interface got smaller?
3. Which owner became authoritative?
4. Which old owner/files/tests were deleted?
5. What happened to cold/warm latency and dependency call count?
6. What is the flake result over repeated execution?
7. Does the deterministic golden journey still pass?
8. Did the independent adversarial agent search the full affected codebase and
   re-review the resolved findings with no blockers?
9. Does `codex/develop-plan-to-refocus-branch-direction` resolve to the reviewed
   gate commit on GitHub?

Reject changes that add another cache, poller, retry, timeout, compatibility
wrapper, environment toggle, process global, or lifecycle owner without removing
the one it replaces in the same slice. Review each vertical slice before starting
the next. This is how the branch returns to forward iteration instead of another
465-commit repair loop.
