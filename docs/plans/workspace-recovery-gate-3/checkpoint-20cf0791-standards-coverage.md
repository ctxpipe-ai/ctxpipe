# Gate 3 final CI-fixture correction — Standards coverage

## Pin and method

- Repository: `/private/tmp/ctxpipe-recovery-01a07aba`
- Focused range: `f7c354334bb91310f3a49f74563bce6497c688ca...20cf0791c4467aacd5719ad58ee39593515300eb`; merge base and single commit verified.
- Reused cumulative review/search coverage through `f7c354334bb91310f3a49f74563bce6497c688ca`; inspected pinned blobs and diff only. No implementation or test process ran.
- Applied retained root/backend standards, ADR-027/028/033, accepted recovery plan, code-review and TDD/mocking guidance. Tooling-enforced matters excluded.

## Changed-surface and caller ledger

- **Production reference:** `apps/backend/src/openworkflow/enqueue-notion-push-sync.ts:13-30` canonicalizes `scopeFromRepo` with `renderNotionConfigYaml`, hashes it with `connectorConfigKey`, and passes that identity to `enqueueConnectorContentSync`.
- **Fixture identity:** `apps/backend/src/openworkflow/enqueue-notion-push-sync.test.ts:10,67-95` imports the same renderer and constructs both the canceled run’s idempotency key and `input.configKey` from the exact production expression. Workflow name, connection, generation, captured binding, and cancellation route remain unchanged.
- **Behavioral assertions:** `enqueue-notion-push-sync.test.ts:96-130` retains failed terminal projection, explicit retry acceptance, initial-sync projection, two-owner cardinality, and generation-2 replacement checks. The non-canceled deduplication/generation branch is unchanged.
- **Delta boundary:** only that test plus `docs/plans/workspace-recovery-gate-3/**` changed. No production callers or interfaces changed, so the cumulative caller inventory remains complete.
- **Evidence inspected:** `logs/notion-canceled-canonical-native-green.{json,log}` records 2/2 passing native cases. `status.md` records the prior CI’s twelve passing non-test jobs, the stale fixture diagnosis, and that required-contract/UI steps did not run after backend failure. Exact-pin CI remains pending.

## Counts

- Documented-standard violations: **0**
- Blocking findings: **0**
- New Fowler judgments: **0**
- Retained Fowler backlog: **9** — Mysterious Name (2), Repeated Switches (1), Duplicated Code (6)
