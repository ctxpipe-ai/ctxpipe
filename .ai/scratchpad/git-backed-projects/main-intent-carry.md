# Main intent carried into Workspaces

Ledger for bringing `main` into PR 280. Each row is a `main` change whose intent must hold in code this branch rewrote. Status: `todo` · `done` · `n/a` (with reason).

## Merge of `origin/main` @ `d733220e` (2026-10-01)

| Main PR | Intent | Branch surface | Status |
| --- | --- | --- | --- |
| #364 | No custom enqueue/job spans; OpenWorkflow 0.10 native `workflow_run` / `step_attempt` spans carry the trace; attribution stamped on the execution span | `openworkflow/client.ts` keeps schema-aware attach + native version assertion only | done |
| #364 | Every job carries org/workspace/connection attribution | 26 branch workflows call `openworkflow`'s `defineWorkflow` directly (all `workspace-*` writes, Confluence/Notion/Linear config+entity, Slack agent, backfill) and get no attribution. Move them to `defineObservedWorkflow` without changing durable input identity | todo |
| #377 | Telemetry export off the request path; short-lived scripts `flushEvlog()` before exit | `db/migrate.ts`; `LoggerHolder` in workspace chat WebSocket stream | done |
| #376 | Bun 1.4.2; `deps` stage on `oven/bun` with pnpm run under Node | backend + worker Dockerfiles (branch keeps OpenCode + git layers) | done |
| #362 | Linear reads through budgeted GraphQL; one durable step per page; one commit | `linear-sync-content.ts` walks pages as steps, then `captureLinearContent` (assets + diff) feeds the native `workspace-connector-mirror` child (one commit) | done |
| #362 | GitHub API commits scale with data: inline UTF-8 in `createTree`, chunk ≤50 entries / ~900 KB | `commitFiles` (config branches only on this branch) | done |
| #298 / #362 | Skip re-downloading unchanged assets by comparing git blob SHAs | `captureConnectorMirrorTarget` returns paths only, so every connector re-downloads assets each sync. Return blob SHAs (`ls-tree -r`) and pass `existingBlobs` for Linear, Notion, Confluence, Slack, PagerDuty | todo |
| #371 | Package hierarchy claims (`linkPackageHierarchy`) after extraction | Branch extraction capture (`repository-ingestion.ts`) | done — verify the typed extract write accepts these claims |
| #371 | Keep an incomplete SCIP shard but report its issue on repository status | `repository-index.ts` returns `ok: false` with `issue`; branch publishes a source revision only when Zoekt and SCIP complete. Decide: does an incomplete shard block publication? | todo |
| #368 | Collapse same-run claim observations per triple + source key; never build an `IN` list past the bind cap; batch prefetch (500) | Extraction merge before the typed extract write; hydrate projection of `claims:` into Postgres | todo |
| #365 / ADR-039 | Production image writes only via `scripts/railway-set-images.sh`; Terraform ignores `source_image` | `deploy.yaml` still has the branch's inline GraphQL roll step after apply — replace with the script, keep role provisioning first | todo (user: workflow edit) |
| — | ADR numbering | Branch ADRs 039–047 renumbered to 040–048 (main took 039) | done |
| — | Single Better Auth type graph | Override `@daveyplate/better-auth-ui>better-call` to 1.3.7, backend `@opentelemetry/api` ^1.9.1, UI declares `zod` ^4 → one `@better-auth/core` | done |

## Found while merging (not from a specific main PR)

| Item | Status |
| --- | --- |
| `scipIndexers.test.ts` "serializes default-output indexers per checkout" hangs ~1 in 5 runs (main test, unchanged code) | todo |
| Linear `schema.graphql` codegen emitted a value import of a type; `useTypeImports: true` | done |
| Main typecheck errors latent because `main` has no CI typecheck (Linear discover query inference) | done |
