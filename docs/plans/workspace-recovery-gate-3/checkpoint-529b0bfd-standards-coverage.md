# Gate 3 immutable-source checkpoint — Standards coverage

## Identity and method

- Repository: `/private/tmp/ctxpipe-recovery-01a07aba`
- Fixed base: `bb24210c01e0dc1bcbc2d4fdf197d07a7a17035d`
- Reviewed pin: `529b0bfd08d1e73618285cc5867c4859062b2c14`
- Merge base and exact pin were verified. The cumulative range contains 31 commits and 1,856 changed paths. The increment from `c4caa83503c4ea1cd1648c86de6574f3107f8144` contains 101 paths (+5,382/-148).
- Read-only inspection used `git diff BASE...PIN`, `git log BASE..PIN`, `git grep PIN`, and `git show PIN:path`. The moving worktree and test execution were excluded.

## Standards applied

- Root, backend, and codesearch `AGENTS.md` instructions.
- Code-review skill and its complete Fowler smell baseline; TDD `SKILL.md` and `mocking.md`; source-connectors skill.
- ADR-027/028 transaction boundaries and updated ADR-033 native durability, source identity, publication, replay, and HTTP admission decisions; Gate 3 status/audit scope.
- Tooling-enforced formatting/type matters were excluded. Memory validation was treated as running, not passing.

## Increment surfaces and caller tracing

- **HTTP admission:** followed `createRepository` persistence/reuse through `enqueueRepositoryIngestionWorkflow`, request preparation/idempotency lookup/activation, repository creation, Confluence save, manual reindex, GitHub webhook, Linear/Notion/Slack parents, ensure-org-repository, and awaited follow-up. The two formerly `void` callers now await and return 503; the native route case asserts failed admission followed by the same persisted repository’s successful retry.
- **Request ownership and metadata ancestry:** checked the generated current-pointer table/schema, repository row lock, captured URL/connection/branch/reason, native-owner lookup, first-step activation, bounded recursive parent recovery, active-owner predicate, cancellation/supersession projection, metadata-only upgrade, and request-fenced running/progress/ready writes. Multi-statement mutations remain within short `withOrgDbContext` transactions and no Git/provider/model I/O occurs there.
- **Immutable indexing:** traced `repositoryRevisionCheckoutKey`, checkout-row creation, source JWT signing/verification, exact target admission, clone/Zoekt/language/SCIP/merge phases, checkout `commitSha` completion marker, and `lastIngestedHash` publication. Older revisions use distinct checkout, Zoekt, and SCIP paths; immutable phase workers do not mutate canonical progress.
- **Published reads:** checked ordinary file/tree/glob/query, lexical search, structural search, and graph selection. Each selects the completed checkout matching `lastIngestedHash` and falls back to `default` only when that row is absent. Explicit workspace and repository-revision claims are mutually exclusive and remain scoped by org/repository/SHA.
- **Captured extraction reads:** traced `RepositorySourceRevision` from all identify/extract callbacks through AsyncLocalStorage. File/glob/tree and structural/lexical clients carry the immutable claim. Public graph tools are the exception reported in the main finding: their schema-created `default` body conflicts with the JWT-selected `rev:<sha>` route key. The new native source test covers public `get_file` and `search`, not a public graph tool.
- **Extraction corrections:** checked existing-subject claim publication, equivalent source normalization, encoded/legacy hash fragments, and source-specific identity/retraction. These preserve owner paths/prose and distinct evidence.
- **Evidence inspected:** committed summaries/logs for 54 affected native cases, 22 consolidated reads, 29 route cases, Linux Node/Bun inventories, backend/UI/codesearch type baselines, policy, and scoped Biome. Results were not rerun.

## Cumulative Fowler disposition

- **Mysterious Name (2):** `sourceId` is converted to `evidenceKey` without naming that equivalence; `contentSyncWorkflowRunId` represents more than content-run ownership.
- **Repeated Switches (1):** connector lifecycle parsing/binding/publication continues provider dispatch in multiple branches.
- **Duplicated Code (6):** the prior four admission/credential/conversation shapes remain. New source-authority/JWT assembly is repeated across four clients, and the published-checkout SQL is duplicated across backend and codesearch. Both new copies encode security/publication invariants and should have one owner or an explicit shared contract.
- No additional Feature Envy, Data Clumps, Primitive Obsession, Shotgun Surgery, Divergent Change, Speculative Generality, Message Chains, Middle Man, or Refused Bequest judgment survived the documented design overrides.

## Counts

- Documented-standard violations: **1**
- Blocking findings: **1**
- Fowler heuristic judgments: **9 cumulative** (2 Mysterious Name, 1 Repeated Switches, 6 Duplicated Code)
