# ctxpipe Gate 4 — Independent Cumulative Reviewer A Re-review 3

**Verdict: CLOSE_GATE_4**

## Pin and scope

- Fixed point: `20cf0791c4467aacd5719ad58ee39593515300eb`.
- Reviewed HEAD: `f8e4fae903ec70d482a12629ed2e59f5ec2ce5ef`.
- Merge base: `20cf0791c4467aacd5719ad58ee39593515300eb`.
- Cumulative range: 45 commits; 388 changed files; 84,604 insertions and 7,834 deletions.
- Final correction from `23dc15f8`: 3 files, 32 insertions and 9 deletions.
- I reviewed current production code, installed patched TanStack source, the final instance-store instrumentation and contracts, prior cumulative review findings, Gate 4's plan/ledger, ADR-034, and exact-HEAD CI state. I did not use subagents and did not implement changes.

## Executive result

The last code blocker is cleared.

The old `definition.ensure` wrapper could not see snapshot-enabled Send because native `withSandbox` calls the private `ensureSandboxWithOutcome` path. HEAD now observes the injected PostgreSQL `SandboxInstanceStore`, which that path necessarily traverses:

- `hits` increments only after an exact key returns a row and `assertOwnedRecord` accepts its tenant/workspace/conversation/provider/image/revision identity.
- `creates` increments when an upsert's exact key was absent before persistence.
- The prepared native second Send brackets those counters and asserts no new instance key, at least one live owned lookup, no Docker provider construction, useful exact text, and elapsed time below five seconds.
- The same-sandbox quota-Docker warm Send brackets the same store counters and additionally asserts unchanged provider construction and image inspection, successful model traffic, useful exact text, and preserved unsaved bytes before provider destruction.

The installed snapshot-enabled native path calls `ensureSandboxWithOutcome`; for a prepared exact owner, it performs one `store.get`, one provider resume, and an upsert of that same record. The retained hit delta therefore observes the previously invisible Send path, while unchanged `creates` and provider/image counters reject allocation or policy reconstruction.

Exact-HEAD CI `34418188719` later failed two quota-Docker contracts (cached
rejected image inspect; OpenCode HostPort colliding with the quota Docker API).
Those are test-process faults, not reopeners of the reviewed ownership axes.
Follow-up `79670977` is green on CI `34421467470` (contracts 334/334), which
satisfies the CI prerequisite for the `Gate 4:` commit.

## Prior-blocker replay

| Prior blocker | Result at HEAD | Evidence |
| --- | --- | --- |
| Public `definition.ensure` wrapping misses snapshot-enabled Send | **Cleared** | The oracle moved to `postgresSandboxInstanceStore`; native snapshot Send calls that injected store through `ensureSandboxWithOutcome`. |
| Prepared warm Send lacks an attach/reuse observation | **Cleared** | Both retained warm journeys require unchanged instance creates and `hits` delta `>= 1`; the native exact-owner path performs one lookup/resume before same-key upsert. |
| Warm answer/provider/image budget | **Cleared** | Native useful answer is `< 5s` with `providerCreates === 0`; quota Docker retains useful same-sandbox output with provider/image counts unchanged. |
| Immutable policy-definition map treated as a lifecycle registry | **Remains cleared** | It stores immutable policy definitions and image identity, not handles, bindings, leases, or lifecycle ownership. I do not reopen it as a registry. |
| Conversation-keyed proxy telemetry | **Remains cleared** | Run identity is carried through the capability/token and proxy attribution; the prior interleaving blocker was corrected. |
| Exact-HEAD full CI | **External prerequisite, not a review blocker** | [CI 34418188719](https://github.com/ctxpipe-ai/ctxpipe/actions/runs/34418188719) is exact HEAD and was `in_progress` when inspected. |

## Standards

### Hard-rule result

No blocking repository-standards violation found.

- The three final-correction files pass Biome with no fixes.
- The final correction passes `git diff --check`.
- The focused native contract passes through the real PostgreSQL/Git/OpenCode/model-proxy composition rather than replacing the owned store or sandbox seam.
- Store reads and writes remain short tenant-scoped operations; no SQL connection is held across provider I/O.
- The change introduces no direct backend `console.*`, new environment variable, hand-written migration, or alternate lifecycle owner.

### Nonblocking judgments

1. **Speculative Generality / Test Code in Production:** `workspaceChatInstanceAccess` is mutable test-visible instrumentation in production code. Its create classification adds one PostgreSQL read before every instance upsert. It does not participate in correctness or ownership, and the final proof needs an observation at this otherwise private native seam, so I do not block Gate 4 on it.
2. **Existing immutable cache lifetime:** `dockerChatSandboxes` and the image-inspection promise live for the process lifetime. They hold immutable policy definitions, not sandbox instances or mutable ownership. This remains a capacity consideration, not the forbidden registry that Gate 4 removed.
3. The cumulative `git diff --check` reports two trailing spaces in the previously committed `checkpoint-058a4a3b-reviewer-b.md` metadata. They are review-document formatting, not code or Gate 4 behavior; the final correction itself is clean.

**Standards: 0 blockers; 3 nonblocking judgments.**

## Spec

### Final blocker analysis

`startWorkspaceChat` always supplies snapshot configuration to native `withSandbox`. Native middleware therefore calls `ensureSandboxWithOutcome`, not the public method that the old `ensures` counter wrapped.

For the prepared current-revision owner exercised by both warm contracts, the native implementation:

1. computes the exact key;
2. calls the injected store's `get(key)`;
3. resumes the persisted provider sandbox;
4. applies current secrets; and
5. upserts the same key with the current run and heartbeat.

HEAD's store counter increments `hits` after ownership validation. Its upsert counter reads the exact key before persistence and increments only if absent. The test snapshots both counters immediately before the warm Send. Thus:

- `hits delta >= 1` proves Send traversed the native existing-owner lookup;
- unchanged `creates` proves it did not allocate a new native key;
- unchanged provider/image counters prove it did not construct another provider/policy or inspect images;
- exact useful text and terminal assertions prove this is a completed chat turn rather than a lookup-only probe;
- the native contract's `< 5s` assertion retains the accepted useful-answer target.

The oracle now observes the actual snapshot-enabled Send seam. It does not rely on a duplicate probe, a second ensure, a provider mock, or the public-method wrapper that caused the previous false confidence.

### Requirement matrix

| Requirement | Result |
| --- | --- |
| Native `defineSandbox` plus PostgreSQL instance/lock authority | Pass |
| Immutable policy definitions do not become a handle/binding/lease registry | Pass |
| Prepare and Send share the same native definition/persisted owner | Pass |
| Restart, replica handoff, exact-key ownership and deletion races | Pass |
| Stock HTTP/WebSocket/MCP chat, persistence, reconstruction and cancellation | Pass |
| Run-scoped model-proxy telemetry under overlap | Pass |
| Zero GitHub work on valid warm runtime resolution | Pass |
| No provider/definition/image reconstruction on prepared warm reuse | Pass |
| Snapshot-enabled Send visibly reuses an existing native instance | Pass |
| No new native key on prepared warm Send | Pass |
| Complete useful native warm answer under five seconds | Pass |
| Same-sandbox quota-Docker warm Send before provider loss | Pass |
| Files/publish/delete/idle paths retain native ownership | Pass |
| Railway unsupported selector fails closed without provider scaffold | Pass |
| Gate 6 20-warm/5-cold distribution harness | Correctly deferred; not required for Gate 4 |
| Exact-HEAD full CI | Still required before the `Gate 4:` commit; not a review blocker |

**Spec: 0 blockers.**

## Simplicity

### Job

Own one conversation's stock TanStack chat and native sandbox across turns, replicas, and restarts, while Files and publication remain focused native-Git commands.

### Thinnest machine

Thin authenticated HTTP/WebSocket/MCP adapters call one stock chat construction. Native TanStack definitions/providers plus PostgreSQL instance and lock stores own sandbox lifecycle. Native persistence and OpenCode own transcript/process behavior. Product code owns authorization, immutable revision/policy input, credential brokering, error translation, publication policy, and run-scoped telemetry.

### Current result

- The former sandbox registry, handle memo, custom port owner, dynamic TanStack loader, manual terminal/persistence repair, assistant-text repair, and console interceptor remain deleted.
- No duplicate ensure/probe was introduced to make the warm test pass.
- The new oracle observes the already-required native store rather than adding a second lifecycle or lease abstraction.
- The immutable policy-definition map remains configuration reuse, not sandbox ownership.
- No Railway provider/SDK scaffold, Gate 6 harness, second Git writer, application lease facade, or active-generation takeover machinery was added.

### Leftover machinery

The two global counter objects and their reset methods are test-control surfaces in production modules, and `creates` costs one extra store read per upsert. This is the only new simplicity debt in the final correction. It neither controls behavior nor duplicates native ownership, so it is nonblocking for Gate 4.

The large temporary TanStack package patches remain maintenance risk, but ADR-034 names their contracts and upstream deletion conditions. No new package patch was added for this correction.

**Simplicity: 0 blockers; 1 nonblocking leftover.**

## Verification performed

Passed locally at exact HEAD:

- Prepared native warm Send contract: 1/1 selected test passed; Vitest file duration 10.16 seconds, test body 5.57 seconds. Its second-Send `< 5s`, useful text, no-create, positive-hit and no-provider-create assertions all passed.
- Biome: all 3 final-correction files checked, no fixes.
- Proof policy: 437 test/story/config files and 29 command files checked.
- Final correction whitespace check: clean.
- Repository worktree remained clean.

The quota-Docker Btrfs journey is retained in the required contract lane and cannot run on this host's non-Btrfs Docker setup. Its unchanged-provider/image plus new store-hit/create assertions are present in the same warm turn. I do not substitute overlay Docker or wait for CI.

At review time, exact-HEAD [CI 34418188719](https://github.com/ctxpipe-ai/ctxpipe/actions/runs/34418188719) and PR Deploy were still running; CLI tests and Changeset Guard were already green.

## Verdict

**CLOSE_GATE_4**

Standards, Spec, and Simplicity have zero blockers at `f8e4fae903ec70d482a12629ed2e59f5ec2ce5ef`.

Do not write the `Gate 4:` commit until exact-HEAD CI is terminal green. That CI requirement is still outstanding, but it does not change this independent code/spec/simplicity verdict.
