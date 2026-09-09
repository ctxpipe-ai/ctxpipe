# G3-C/E Spec coverage — `dc7c51e7...f95422b8`

## Pinned scope

- Target: `f95422b8c35620246ddbb884c2c6e82a5b5f64a7`
- Increment base: `dc7c51e77441d69ead16602f6263624964136dd9`
- Cumulative Gate 3 base: `bb24210c01e0dc1bcbc2d4fdf197d07a7a17035d`
- Commit: `f95422b8 Gate 3: prove sandbox crash recovery and avoid duplicate CI contracts`
- Requirements: recovery plan test architecture and Gate 3 (451-452, 642-659), ticket 09 (89-93), ticket 10 (80-105), ADR-033 resource/retry decisions, current G3 ledger.

## G3-C correction

| Boundary | Pinned source | Assessment |
|---|---|---|
| Adopted human revision | `workspace-bootstrap.ts:180-200` | Adoption is followed by durable, idempotent hydrate admission before continuation. |
| Satisfied no-op | `workspace-bootstrap.ts:329-343`; `workspace-unborn-bootstrap-native.contract.test.ts:235-269` | Projection reaches the human SHA before completed replay returns `no_changes`; prior P1 closed. |
| Partial human root | initialized hydrate key and later ordinary hydrate key | Two revisions may hydrate independently; existing desired-SHA activation CAS prevents the earlier revision replacing the later bootstrap result. |

## G3-E recovery proof

| Claim | Pinned source/evidence structure | Assessment |
|---|---|---|
| Lost Docker create reply | `native-docker-ack-loss.ts:1-83`; `write-worker-loss-native.contract.test.ts:63-73,336-369` | Proxy forwards native Unix-socket create and withholds only the first 201. Test inspects real ID before SIGKILL and the identical ID after two replacement processes start. |
| Kill during model call | `write-worker-loss-native.contract.test.ts:105-153,336-370` | First semantic HTTP request is held until the original worker is killed; replacement performs the second request through the real model client. |
| One durable result | `write-worker-loss-native.contract.test.ts:370-384,402-403` | Final Git content preserves both sides; range contains human+one job commit; exactly one write credential is issued. |
| Cleanup | `workspace-semantic-merge.ts:218-267`; `workspace-semantic-cleanup.ts:8-35`; test lines 385-401 | Cleanup is admitted before allocation, immediate destroy removes the resource, and independent expiry workflow reaches completed after its second absence confirmation. Fixture force-removal is only failure cleanup. |
| Real worker/process boundary | generated worker script and `launch`/`kill` logic in `write-worker-loss-native.contract.test.ts` | Original and two replacements are separate Bun processes sharing only PG/OpenWorkflow and Docker; SIGKILL removes process-local state. |

## Runtime floor

- `package.json:5-9` requires Bun `^1.4.2`.
- `scripts/ci/prerequisites.mjs:26-36` rejects 1.x versions below 1.4.2.
- `.github/workflows/ci.yaml:116-119,211-214` installs 1.4.2.
- Backend, worker, codesearch, Zoekt, docs, and UI Bun runtime stages are all pinned to 1.4.2.
- Historical evidence references were not treated as active pins.

## CI partition and failure policy

- `scripts/ci/test-suite.mjs:31-58` discovers all tracked/untracked tests, validates every required contract path, and partitions by exact set membership.
- Backend is the complement; contracts are the set, so files execute once when both CI commands run.
- Lines 59-121 preserve nonempty checks, prerequisites, allowlist-history enforcement, inventory emission, abnormal runner detection, and `check-test-report` validation.
- `scripts/ci/failures/contracts.json` remains empty; the single acknowledged backend failure remains with the backend complement.
- `.github/workflows/ci.yaml:142-153` still runs both commands sequentially in the fully provisioned test job.
- `--list` branches before prerequisites/test execution and is a preview only; it cannot create a passing test report.
- Contract timeout increases from 900 to 1,200 seconds, still a hard bound above the measured two-boundary cleanup duration.

## Exclusions

G3-F audit and G3-G/other gates were not reviewed. Historical logs were not reread, tests were not rerun, and repository files were not modified.
