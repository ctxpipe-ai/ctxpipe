Continue implementation for Confluence sync port in `ctxpipe` from the current branch/worktree.
A large part is already implemented; do not redo completed work.
If anything is unclear, ask clarifying questions before coding.

## Context to read first
1. `.agents/plans/confluence_sync_port_36b3aef6.plan.md`
2. `AGENTS.md`
3. `apps/backend/AGENTS.md`
4. Current implementation files:
   - `apps/backend/src/routes/v1/connectors-atlassian.ts`
   - `apps/backend/src/routes/webhooks/atlassian/atlassian.ts`
   - `apps/backend/src/openworkflow/confluence-sync-content.ts`
   - `apps/backend/src/openworkflow/confluence-sync-space.ts`
   - `apps/backend/src/openworkflow/confluence-sync-config.ts`
   - `apps/backend/src/services/confluence/*`
   - `apps/backend/src/services/github/installation-write-client.ts`
   - `apps/ui/src/features/connectors/components/ConnectorSetupDialog.tsx`
   - `apps/ui/src/features/connectors/EditScopeModal.tsx`

## Already done (do not re-implement)
- `confluence_sync_targets` schema + migration
- consolidated Atlassian `GET/POST /config`
- workflow enqueue on config save and webhook event
- initial Confluence service layer + GitHub installation write client
- setup/scope UI split using `/config`
- basic backend tests for `/config` and webhook enqueue path

## Remaining work to complete
1. Workflow resilience
   - Add bounded retry/backoff for transient Confluence/GitHub failures (429/5xx/network) in Confluence sync workflows.
   - Ensure retry policy is explicit and deterministic (max attempts, backoff strategy).
   - Preserve partial-failure semantics (`completed | partial_failed | failed`) with structured logs.

2. Confluence conversion fidelity
   - Improve `services/confluence/converter.ts` to better preserve Confluence content semantics in Markdown.
   - Keep deterministic pathing with `--<pageId>` suffix and managed root safety.

3. Test coverage for unimplemented plan items
   - Unit tests:
     - Confluence client pagination/error handling
     - converter deterministic pathing + collision behavior
     - config YAML diff/no-change behavior
     - GitHub installation write client core operations (mocked Octokit)
   - Workflow tests:
     - success/partial/failed transitions
     - retry behavior and exhaustion behavior
   - Add/extend integration tests where practical around `/config` + webhook incremental sync flow.

4. Safety/idempotency hardening review
   - Re-check deletion confinement to `confluence/` only.
   - Ensure no-change runs skip writes/commits cleanly.
   - Confirm config PR only opens when `confluence/config.yaml` changes.

## Validation required before finishing
Run and report:
- `pnpm --filter @ctxpipe/backend test` (or targeted suite if full has unrelated failures, but state exactly what ran)
- `pnpm --filter @ctxpipe/ui test`
- relevant lint/type checks for edited files
- any migration impact check if schema changed

## Output format
- List exactly what was changed (file paths)
- Note unresolved risks/gaps
- If anything in plan conflicts with current architecture, stop and ask for direction instead of assuming.
