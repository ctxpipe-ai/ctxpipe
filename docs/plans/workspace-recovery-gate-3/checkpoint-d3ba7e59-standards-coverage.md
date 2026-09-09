# Gate 3 cumulative closure — Standards coverage

## Identity and method

- Repository: `/private/tmp/ctxpipe-recovery-01a07aba`
- Fixed base: `bb24210c01e0dc1bcbc2d4fdf197d07a7a17035d`
- Reviewed pin: `d3ba7e591ecb557ca1e5c3da96ec9e99d0dd1f67`; merge base verified; 40 commits, 2,122 changed paths (500 excluding Gate 3 evidence logs).
- Focused increment: `f95422b8c35620246ddbb884c2c6e82a5b5f64a7..d3ba7e591ecb557ca1e5c3da96ec9e99d0dd1f67` (one commit, 48 paths, +2,760/-1,392).
- Read-only pinned `git show`, `git diff`, `git grep`, and prior checkpoint coverage were used. No implementation or test process ran.

## Standards

- Root/backend `AGENTS.md`; code-review and TDD/mocking skills; ADR-027/028/033; accepted recovery plan; `remaining.md`, `ownership-audit.md`, and prior pinned coverage.
- Tooling-enforced formatting/type matters were excluded. Gate 4 conversation adapter and pre-upgrade cleanup retention were treated as the documented boundary, not Gate 3 omissions.

## Cumulative interface and caller ledger

- **Admission and ownership:** traced `enqueue-workspace-write-commit.ts` through immutable job persistence, returned-owner reconciliation, all twelve typed workflow registrations, workflow-name/version/namespace status lookup, paused owner adoption, and worker wake. Generic workflow/runner/agent/transform files are absent at the pin.
- **Native Git:** traced acquired shallow packs and boundaries, deterministic stage/validate/commit, prepared-commit persistence, normal and unborn broker pushes, non-fast-forward/three-attempt semantic handoff, ancestry-based lost-ACK recovery, publication, and hydrate admission. Durable state contains Git objects and identities, not credentials/directories.
- **Write authority:** enumerated production `getRepoWriteCloneToken`, native `push`, GitHub commit/ref/content APIs, and `commitFiles` callers. Default-branch writes resolve only through `write-broker.ts`; conversation publication targets a checked session branch; Linear/Notion/Confluence and MCP onboarding use checked feature branches.
- **SQL boundaries:** covered workspace admission/status, job/result/handoff/planner metadata, export path assignments, connector activation/finalization, repository ingestion requests/owners, generated migrations, and tenant scope. External Git, provider, model, and indexing calls occur outside organization transactions; final binding changes use row locks/CAS.
- **Maintenance and recovery:** covered bootstrap (including unborn/adopted roots), file edit, import-key cleanup, claims upgrade, valid-from, folder map, link/unlink, export, rename, extraction, connector mirror, semantic merge, hydration planning/caps, pause/protection resume, no-op publication, repeated races, process/filesystem loss, allocation deadline, and independent cleanup.
- **Connectors:** traced Linear/Notion/Confluence/Slack parent capture to typed mirror child, immutable config/provider/repository identity, terminal projection, proposal/content owner ordering, supersession, and canonical configuration comparison. The F increment’s Notion rendered key and Confluence normalized selection preserve reorder/empty/A–B–A identity.
- **Extraction/indexing:** covered immutable typed batches, live producer handoff, pure Git adapter, removed DB/graph/embed writer, source declaration capture, root/source bounds, claim merge/retraction/evidence normalization, request-fenced progress, immutable checkout publication, captured tool scope, and restart/admission recovery.
- **Read/publication surfaces:** covered published Workspace Files tree/blob/clean status, conversation publication/capability, revision-bound PR projection, indexed source reads, and UI consumption. The retired job sandbox can no longer leak dirty files into workspace status.
- **Retirement:** `ensureJobSandbox`, `createTanstackJobSandbox`, provider selection, clone/token seeding, and their allocation-time registration path were removed with the obsolete mocked suite. Pinned production searches found no caller. `adaptTanstackHandle` remains called by `conversation-files.ts`; registry destruction remains called by lifecycle/tip-check/routes. The registry's generic registration/getter exports now have test-only references, so they do not create an alternative runtime job owner.
- **Proof integrity:** reviewed native Git/PostgreSQL/OpenWorkflow/HTTP contracts, SIGKILL/proxy seams, fixture ownership/cleanup, fresh/upgrade migrations, test-inventory partition and required-contract failure rules. Reported 132-diagnostic/type, policy 441/27, and native counts were accepted as committed evidence, not rerun. Candidate CI remains pending.

## Blocking path

- ADR-033:46 requires repository-subject `AGENTS.md` claims to use an owner-preserving merge and preserve body bytes.
- `extraction-source.ts:61-68` skips candidate comparison for that subject. Linked sources receive parent blob/path plus body/non-claims comparison at `:69-114`.
- `semantic-merge.ts:125-183` accepts full content for conflict paths; `workspace-semantic-merge.ts:216-327` stages and brokers it.
- `write-broker.ts:114-120,154-162` invokes the insufficient check both before and after write-credential I/O.
- The new negative cases at `write-extraction-admission-native.contract.test.ts:63-133` cover linked declarations only. Repository extraction has positive root-claim proof but no semantic root body/metadata/deletion rejection.

## Findings and backlog counts

- Documented-standard violations: **1**
- Blocking findings: **1**
- New Fowler heuristic judgments: **0**
- Retained Fowler backlog: **9** — Mysterious Name (2), Repeated Switches (1), Duplicated Code (6)
