# G3-C Spec coverage — `9a1c5fac...ce00e052`

## Pinned inputs

- Base: `9a1c5fac4fd6d8e2298a5fc25d8873239b22bcbf`
- Target: `ce00e052b18bceda71909afde37443070b03f5a8`
- Cumulative Gate 3 base retained: `bb24210c01e0dc1bcbc2d4fdf197d07a7a17035d`
- Commit: `ce00e052 Gate 3: bootstrap unborn repositories through the durable write owner`
- Sources: recovery plan Gate 3 (642-659), ticket 09 (70-110), ticket 10 (37-96), ADR-033 (7-28, 59), and the milestone ledger.

## Requirement trace

| Requirement | Pinned implementation traced | Assessment |
|---|---|---|
| No fictional read SHA; empty read stays non-failing | `resolve-revision.ts:71-124`, `bootstrap-input.ts`, `bootstrap-unborn.ts:26-47`, `enqueue-workspace-hydrate.ts:17-45` | Meets G3-C: verified unborn returns no revision; hydrate records no false failure. |
| One typed durable owner and one result | `enqueue-workspace-write-commit.ts:189-235`; `workspace-write-jobs.ts:881-994`; `workspace-bootstrap.ts:86-227` | Meets: pre-commit binding is immutable; adoption remains in the original job/run and clears only its unpublished candidate. |
| Native first root, allowlist, no parent | `unborn-tree.ts:10-150`; `workspace-bootstrap.ts:119-151` | Tree and parentless native commit meet scope/shape. Subject violates ticket 10 (main finding). |
| Actual default, no force, credential/binding fences | `write-broker.ts:407-549`; `bootstrap-unborn.ts:10-47` | Meets: symbolic remote HEAD captured, generation/URL/connection/default checked, write token local to broker, ordinary push has no force. |
| Human first writer | `write-broker.ts:427-462,484-497`; `workspace-write-jobs.ts:947-994`; normal bootstrap continuation at `workspace-bootstrap.ts:217-405` | Meets: unrelated human files remain and one job commit is added only when needed. |
| Lost push reply and descendant tip | `write-broker.ts:198-229,521-532`; publication `232-266`; root workflow `153-211` | Meets: ancestry recognizes the candidate, publication refreshes canonical tip, hydrate enqueue precedes completion. |
| Create/select/relink wiring | `workspace-lifecycle.ts:38-99,125-193`; route callers `routes/v1/workspaces.ts:340-356,384-422` | Meets milestone requirement. Bootstrap is independent of hydrate/export and failures are logged asynchronously. |

## Adversarial cases inspected

- Simultaneous bootstrap owners: loser observes the initialized branch and converges through adoption/no-op rather than overwriting it.
- Human initialization during credential issuance: branch is re-read; non-fast-forward falls into initialized inspection.
- Relink/generation/default/write-status changes: checked before credential issuance and again immediately before push; stale publication is rejected.
- Push succeeds but response is lost: remote ancestry and canonical publication prevent a second root commit.
- Replay after adoption: stored real revision is matched; the discarded root candidate is not published.
- Empty readable but unwritable repository: hydration remains non-failing while the owned bootstrap pauses.

## Exclusions

G3-D–G and cumulative nonblocking heuristics were not reopened. Evidence logs were not rerun or treated as substitutes for source tracing. No repository files were changed.
