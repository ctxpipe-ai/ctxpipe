# Standards review — `6bae4242686cc2438a3ac0fa326ca44e748f0b7d`

**Pinned range:** `bb24210c01e0dc1bcbc2d4fdf197d07a7a17035d...6bae4242686cc2438a3ac0fa326ca44e748f0b7d`  
**Result:** 2 documented violations; 2 heuristic smells; 2 implemented-scope blockers.

## Documented-standard violations

1. **Notion token refresh crosses transaction ownership.** Both capture paths wrap `updateNotionConnectionTokens` in `withOrgDbContext` (`services/notion/sync.ts:175-188,344-357`). The callee reuses that transaction for `connections`, then calls `upsertConnectionDirectory` before the outer transaction commits (`models/notion-connector.ts:386-425`); that helper writes through `getSystemDb()` (`connection-directory.ts:46-59`). This violates backend `AGENTS.md:11` (“use the transaction object `tx` for all operations within the transaction”) and defeats the intended post-commit directory projection. Make the model method open its own explicit org transaction from `input.orgId`, finish it, then update the directory; callers should not wrap it.

2. **One-use dispatch is global.** `connector-mirror.ts:31-36` hoists `bindingReaders`, but only `assertConnectorMirrorBinding` uses it at lines 71-74. Root `AGENTS.md:172` forbids moving one-off values to module scope unless reused. Inline it or make the provider lookup the function’s local dispatch.

## Fowler heuristic smells (judgment calls)

1. **Duplicated Code.** Linear, Notion, and Confluence full/incremental parents repeat target capture, fresh credential checks, and mirror-child assembly (for example `notion-sync-content.ts:40-131` and `notion-sync-entity.ts:40-148`; Confluence equivalents span `:30-114` and `:27-116`). Share pure provider helpers while keeping every durable `step.run`/`step.runWorkflow` explicit as ADR-033 requires.

2. **Primitive Obsession.** `configBlobSha` defines a new raw 40-hex regex (`connector-mirror.ts:23-26`) while the canonical Git SHA domain accepts 40 or 64 hex (`revision.ts:10-18`). A SHA-256 Git object is rejected before the mandatory scope fence runs. Reuse one Git-object-ID schema/type.

The native parents otherwise meet ADR-033’s secret-free capture/typed-child boundary; Slack’s model selects intent only, and Confluence suppresses destructive reconciliation after provider failures. Declared lifecycle/finalization and alternate-writer work was excluded.
