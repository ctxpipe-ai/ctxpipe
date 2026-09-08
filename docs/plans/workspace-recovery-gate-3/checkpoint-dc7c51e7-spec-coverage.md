# G3-C/D Spec coverage — `ce00e052...dc7c51e7`

## Pinned scope

- Increment base: `ce00e052b18bceda71909afde37443070b03f5a8`
- Target: `dc7c51e77441d69ead16602f6263624964136dd9`
- Cumulative base retained: `bb24210c01e0dc1bcbc2d4fdf197d07a7a17035d`
- One commit: `dc7c51e7 Gate 3: prove extraction publication and close unborn replay gaps`
- Specs traced: recovery plan Gate 3 (642-659), tickets 02 (32-54), 03 (30-45), 09 (82-110), 10 (37-96), 11 (47-63, 88-96), ADR-033 (7-28, 40-59), current G3 ledger.

## G3-C corrections

| Boundary | Pinned source | Result |
|---|---|---|
| Every commit gets model subject with fallback | `workspace-bootstrap.ts:148-168`; `commit-subject.ts:64-86`; native assertion at `workspace-unborn-bootstrap-native.contract.test.ts:231-234` | Prior finding closed. Subject is a durable step result and exact model output reaches `commit-tree`. |
| Completed adopted no-op replay | `workspace-bootstrap.ts:97-123`; `workspace-write-jobs.ts:947-994` | Result ownership/replay is corrected, but hydration is missing (main finding). |
| Adoption continuation/no-op | `workspace-bootstrap.ts:180-190,235-343` | Human commit is preserved and candidate discarded; satisfied branch completes without activating the adopted SHA. |
| Unborn publication/recovery | `write-broker.ts:407-549`; `workspace-bootstrap.ts:171-229` | Non-force actual-default push, binding checks, ancestry-based lost-ACK recovery, hydrate-before-complete on the root-commit branch remain sound. |

## G3-D producer and isolation

| Boundary | Pinned source | Result |
|---|---|---|
| Durable owner and current request | `enqueue-repository-ingestion.ts`; `repository-ingestion-orchestrator.ts:7-49`; `repository-ingestion-requests.ts:18-265` | Namespace/name/version, repository binding, request ID, activation, progress, terminal authority, and follow-up ownership are fenced. |
| Source resolve/index | `repository-ingestion.ts:150-291`; `repository-index.ts:45-397` | Resolved SHA is durable child input; credentials are transient; source JWT names repository+SHA; immutable checkout is created before phase work. |
| Older clone after newer publication | `repository-index-source-native.contract.test.ts:28-185`; `repositories.ts:54-79,440-469` | Old/new artifacts have distinct revision keys. Ordinary readers select `lastIngestedHash`; captured extraction tools retain the older SHA. |
| Root/model extraction | `repository-ingestion.ts:293-530`; `extraction.ts:8-105`; ingest agent context/tool callers | Roots, fan-out, aggregate payload, and final command are bounded. Each tool call is scoped to the captured source SHA; final batch schema rejects excess rather than truncating. |
| Destination and declaration authority | `capture-repository-extraction.ts:12-54`; `extraction-source.ts:16-79` | Destination captured before model work; linked declaration blob/path and current source request are checked during acquire, push, and semantic continuation. |
| Typed Git publication | `repository-ingestion.ts:484-541`; `workspace-extract-ingest.ts:47-252`; `write-broker.ts:73-181` | Immutable extraction batch enters one typed child/job, uses native stage/validate/commit and broker-only write credential, then hydrates before completion. |
| Final source publication/follow-up | `repository-ingestion.ts:544-646`; request-conditioned repository model updates | Only current owner can publish readiness; failed Zoekt retains the previous published source; a moved tip admits one bound follow-up. |
| Full-path proof | `repository-producer-native.contract.test.ts:24-296` | Uses real PG/OpenWorkflow, owner/index/codesearch/root/model adapter/native Git/typed child; only GitHub/model HTTP are substituted. It asserts the extracted instruction and one Git commit. |

## Adversarial checks

- Request supersession before or during the typed child is rejected by `assertRepositoryIngestionRequest`, including the final pre-push recheck.
- Destination relink or linked declaration edit invalidates acquisition/publication rather than rebasing stale extracted content.
- Source tip movement without a replacement request is followed after current publication; explicit branch remains explicit and default selection is re-resolved.
- A late old index cannot change `lastIngestedHash` through the current-owner predicate and cannot overwrite a newer immutable checkout.

G3-E–G, the earlier nonblocking heuristic backlog, and unrelated fixture namespace cleanup were excluded. No tests were rerun and no repository files were changed.
