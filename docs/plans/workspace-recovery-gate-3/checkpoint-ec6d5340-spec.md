# Spec review — `ec6d5340`

**Pinned range:** `bb24210c01e0dc1bcbc2d4fdf197d07a7a17035d...ec6d5340c4db91c4e888540deedddaa891ad9f58`

## Finding

1. **[P1] Connector admission recovers and activates a same-name/key run from the wrong workflow version.** `runWorkflowWithWorkerWake` correctly rejects a returned handle whose version differs from the requested spec (`openworkflow/client.ts:14-24`), but both connector enqueuers catch that rejection and call `findConnectorSyncOwner` (`enqueue-connector-config-sync.ts:90-98`; `enqueue-connector-content-sync.ts:67-75`). That lookup filters name/key/org/connection but not `version` (`connector-content-sync.ts:335-349`), and `activateConnectorSync` likewise validates only the name and input identity (`connector-content-sync.ts:215-230`). Thus, if OpenWorkflow returns an older explicitly versioned `linear|notion|confluence-sync-{config|content}` run for the same native idempotency key, the wrapper rejects it, recovery immediately selects it, and activation can publish it as the current owner. `prepareConnectorSync` can also reuse a stored wrong-version owner before enqueue (`connector-content-sync.ts:160-183`). This contradicts ADR-033:18: **“Native idempotency is name/key scoped; admission rejects a returned run from another version.”** Require the expected workflow version (currently SQL `version is null`) in all three connector owner queries, and add config/content collision cases analogous to the new workspace-write proof.

## Verified corrections

Both fd7 findings are closed. Claims-only existing-subject projection now passes the original file into YAML mutation (`migration-export.ts:96-120,672-689`), and the native contract compares the complete `AGENTS.md` instruction suffix byte-for-byte. `canonicalEvidencePath` maps dot-root forms to `""` and rejects traversal (`retract-extraction.ts:13-52`); URL, parent, and relative root cases are covered.

The connector restart fence also works for the tested implementation: the durable capture retains its old binding, resumed Linear/Notion/Confluence workflows reject a reloaded target mismatch and recheck the full admitted binding immediately before synchronization (`*-sync-config.ts`). No content child is admitted in the native restart cases.

Gate 3 remains open for the separately declared acceptance inventory.
