# Gate 0 non-backend test classification review

Fixed source: PR head `1fad8412525efdeefdfa4899fe9a2f41dfbbc1c8`.

Scope was taken from `docs/plans/workspace-recovery-gate-0/test-classification.tsv`: every row with `kind=test` whose path is outside `apps/backend`. All 108 source files were inspected from the fixed commit with their imports, setup, assertions, skips, process/filesystem/network behavior, and mock boundaries. Stories are excluded for the root reviewer; backend tests are excluded for the backend reviewer.

## Rubric

- **Proof**: the asserted owned invariant runs directly. Real filesystem, real CDK synthesis, real CLI subprocesses, and controlled external boundaries such as fetch/process adapters remain proof when the owned implementation is intact.
- **Characterization**: useful current behavior or wiring is recorded, but an owned implementation seam is replaced, or a component is checked only as static markup rather than through its browser interaction boundary.
- **Redundant**: no unique actionable oracle. No whole file in this slice met that threshold; overlap was retained where it checks a distinct integration or composition seam.

Classification is about oracle quality, not execution status. A proof row can still be skipped, fail, or require an unavailable prerequisite.

## Coverage and counts

| Surface | Files | Proof | Characterization | Redundant |
| --- | ---: | ---: | ---: | ---: |
| `apps/codesearch` | 33 | 21 | 12 | 0 |
| `apps/ui` | 61 | 48 | 13 | 0 |
| `packages/aws-cdk` | 4 | 4 | 0 | 0 |
| `packages/cli` | 10 | 9 | 1 | 0 |
| **Total** | **108** | **82** | **26** | **0** |

## Blocking quality gaps and later owners

1. Codesearch route coverage is characterization because graph, indexing-phase, repository, pin/warmup, search, ref, or structural-search owners are mocked. Gate 2 needs deterministic contracts across the real route-to-domain seams; the real Zoekt integration proof must actually execute in the Docker lane.
2. `scipIndexers.test.ts` and `heartbeat.test.ts` do not execute a real indexer process. Gate 2 owns the real process, artifact, heartbeat, and cleanup proof; the required Docker/indexer lane remains missing.
3. UI component/session tests based on static markup or owned-module mocks characterize current chrome. Gates 4–6 need Storybook browser interactions and the integrated journey for chat streaming, publishing, file behavior, auth/provider composition, and navigation.
4. `packages/cli/test/memory/evals/live-eval.test.ts` contains an unconditionally skipped Layer B runner. Its scenario-shape assertion remains characterization; Gate 1 owns removal or implementation of the unconditional skip.

## Completeness checks

- Input inventory: 108 unique paths; 33 codesearch, 61 UI, 4 CDK, 10 CLI.
- Output inventory: 108 unique rows plus one header.
- Every output row uses `kind=test`, `has_play=n/a`, an explicit classification, an owner gate, and source-specific evidence.
- Every row in this review slice is fully classified and assigned.
