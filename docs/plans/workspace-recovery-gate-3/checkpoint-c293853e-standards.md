# Standards review — `c293853e9d062b2cf23c5d89805ebc9c7737bdcd`

**Pinned range:** `bb24210c01e0dc1bcbc2d4fdf197d07a7a17035d...c293853e9d062b2cf23c5d89805ebc9c7737bdcd`
**Result:** 1 documented violation; 2 heuristic smells; 1 implemented-scope blocker.

## Documented-standard violation

1. **Linear finalization still has two transaction owners.** `linear-sync-content.ts:181-190` wraps `finalizeLinearBindingAfterContentWorkflow` in `withOrgDbContext`. The model then performs its directory lookup, opens a nested `withOrgDbContext`, updates `connections`, and calls the system-DB `upsertConnectionDirectory` (`linear-connector.ts:1253-1305`). Because nested contexts reuse the caller’s transaction (`db/client.ts:120-167`), the directory projection occurs before the outer tenant transaction commits. This repeats the corrected Notion defect and violates backend `AGENTS.md`’s transaction rule (“use the transaction object `tx` for all operations within the transaction”) plus ADR-033:25’s short-transaction boundary. Call the self-owning finalizer directly from the durable step (and preferably assert no ambient org context).

## Fowler heuristic smells (judgment calls)

1. **Duplicated Code.** The same generated `git` push barrier/rebind harness is copied into Linear (`linear-mirror-native.contract.test.ts:84-139`), Notion (`notion-mirror-native.contract.test.ts:83-139`), and Confluence (`confluence-mirror-native.contract.test.ts:107-170`). Extract one native-Git race fixture so later race semantics change once.

2. **Data Clumps.** All three finalizers and their workflow calls repeat `{ connectionId, repositoryId, branch, workflowStatus }` (`linear-connector.ts:1253-1258`, `notion-connector.ts:947-952`, `confluence-sync-target.ts:301-306`). Give this captured finalization identity a shared domain type while retaining provider-specific persistence.

The prior binding-reader, Notion-token transaction, and Git-object-schema findings are corrected. Slack terminal failure projection uses the owning failed child step and evlog context; connector finalizers fence repository/branch; export completion precedes the parent-owned, replayable hydration enqueue as ADR-033 requires. Declared audit items were excluded.
