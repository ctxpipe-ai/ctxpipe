# Gate 3 test correction — Spec review

Pinned target: `20cf0791c4467aacd5719ad58ee39593515300eb`; focused increment: `f7c354334bb91310f3a49f74563bce6497c688ca..20cf0791`.

## Findings

No blocking Spec findings.

The test-only correction aligns the canceled Notion fixture with production. Both now compute the content owner’s `configKey` as `connectorConfigKey(renderNotionConfigYaml(scopeFromRepo))`, so the pre-created canceled run has the exact idempotency key and immutable input that `enqueueNotionFullSyncAfterConfigPush` resolves.

The behavioral assertions are unchanged: the canceled owner projects `sync_failed`; explicit retry creates a second owner at generation 2 and restores `initial_sync`; the ordinary path still verifies equivalent-event reuse and A→B→A generations 1, 2, and 3. The change therefore restores proof of ADR-033’s canonical proposal identity and terminal-owner recovery rather than weakening the contract.

No production file changed. The cumulative ownership audit and prior zero-finding correction reviews remain applicable.

**Count:** 0 Spec findings. Candidate CI remains pending, so this report does **not** declare Gate 3 complete.
