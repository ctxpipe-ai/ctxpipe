# Standards coverage — `5136c8734c433347786470a61589d64c4c3b3858`

## Identity and method

- Fixed base: `bb24210c01e0dc1bcbc2d4fdf197d07a7a17035d`; pinned target: `5136c8734c433347786470a61589d64c4c3b3858`; merge base equals the fixed base. All 22 commits were enumerated.
- Increment: `5136c873 Gate 3: preserve restored publishing and bind PR and connector results`.
- Used pinned `git diff`, `git log`, `git show TARGET:path`, `git grep TARGET`, and `git cat-file` only. The moving checkout was ignored. No implementation or test processes.
- Applied root/backend `AGENTS.md`, ADR-027/028/033, accepted Gate 3 status/audit, TDD/mocking, and the complete Fowler baseline; tool-enforced formatting was excluded.

## Incremental changed surface

The increment has 75 paths, including 22 TypeScript paths (eight tests), one generated migration/snapshot, ADR/status/audit updates, and saved proof logs. Reviewed production changes in:

- conversation schema/model, publication domain, lazy sandbox warming, push/PR routes, and chat lifecycle;
- shared connector-finalization model, Linear/Notion/Confluence models and native parents;
- migration ordering and all affected test/fixture seams.

## Interface and caller ledger

### Restored conversation publication

- `pushConversationSessionBranch` still has exactly two production callers: Files push and conversation PR.
- It now resolves default and session tips before packing. If local HEAD equals default it reports no changes; if it equals the session tip it rechecks the DB binding and returns `pushed:false` without a write credential. Otherwise it requires the remote session tip (or captured default SHA) to be a local ancestor, creates a thin delta against that base, fetches the base into the broker directory, streams 256 KiB chunks, validates the pack/commit, rechecks actual default plus DB binding, and pushes with an exact session-ref lease.
- The agent still receives no credential. The previously reviewed thin file-to-`index-pack` stream remains intact.
- `warmConversationSandbox` now calls `checkoutPreparedConversationBranch`, which records branch and registered URL/connection/generation/SHA/default metadata. Callers are lazy Files attachment and the explicit Prepare route.

### PR identity and projection

- Generated migration `20260908175806_silent_whiplash` adds nullable `conversations.last_chat_pr_revision`; legacy values remain unbound.
- `persistConversationPublication` writes the revision only with a PR number while holding the matching workspace binding lock. Direct branch-only projection leaves PR fields untouched.
- `conversationSelection` is used by ensure-existing, list, paginated list, get, workspace lookup, and update-returning. Its computed PR number requires workspace id, generation, URL, connection, and default branch to match the stored PR revision. SHA is intentionally omitted so a PR remains visible after ordinary same-binding tip advancement.
- GET PR additionally requires the actual GitHub head to equal the deterministic conversation session branch. POST reuses an existing PR only under the same head; otherwise it creates and binds a new one.
- Finding: selection also returns the raw revision column, and list/detail/update route spreads expose it despite the public Zod/OpenAPI schema omitting it.

### Connector finalization

- New `CapturedConnectorBinding` bundles repository id, full workspace revision, and provider identity: Linear/Notion workspace id or Confluence cloud/base URL.
- Its only checker, `lockConnectorFinalizationBinding`, is called by the three provider finalizers. It selects and row-locks workspace, repository, and connection in the caller's ambient org transaction, verifies provider status/identity and captured generation/URL/GitHub connection/default/repository binding, and performs no provider/Git/model I/O.
- Linear and Notion finalizers obtain the connection-directory org outside SQL, then own one short `withOrgDbContext`; their directory projection follows commit. Confluence resolves org before its short model-owned transaction. Provider parents pass durable step-captured identities.
- This closes the prior four-field connector Data Clump. Configuration activation ABA and terminal setup failure remain explicitly open.

## Proof disposition

- Restored-session native proof covers depth-one unchanged and edited branches, absence of the captured default object, unchanged default, and no duplicate push.
- HTTP native proof adds Files-only lazy warm/push, hidden prior-generation PR, unrelated PR-number collision, branch-head validation, and binding projection.
- Fresh and upgrade migration proof is saved. Connector model/workflow native proof covers all three providers, generation changes, and provider workspace/cloud changes.
- Saved claims inspected: 33 publication assertions; 20 retained lifecycle/route checks; 25 connector checks; backend types at 140 acknowledged diagnostics; scoped Biome and proof policy. The noted broad publication failure was fixture teardown and its corrected targeted evidence was inspected.

## Fowler baseline disposition

- Reported: new **Mysterious Name**, consolidated publication **Duplicated Code**, and two remaining duplication sites.
- Closed: connector-finalization **Data Clumps**.
- No additional actionable Feature Envy, Primitive Obsession, Repeated Switches, Shotgun Surgery, Divergent Change, Speculative Generality, Message Chains, Middle Man, or Refused Bequest.

## Counts

- Documented-standard violations: **1**
- Heuristic smells: **4**
- Implemented-scope blockers: **0**
