# Gate 3 semantic/model checkpoint — Standards review

**Pinned range:** `bb24210c01e0dc1bcbc2d4fdf197d07a7a17035d...bafb805b2c16b2b9816d4bada2c4b692282c8945`
**Decision:** changes requested — 2 documented-standard findings (1 P1, 1 P2), 0 Fowler heuristic findings.

## Documented-standard breaches

### [P1] Use a sandbox provider available to the hosted worker

`apps/backend/src/domain/workspaces/semantic-merge.ts:32-48` calls provider detection with `hasDocker: true`, supports Docker/local-process only, and explicitly rejects `railway`. The deployed OpenWorkflow service receives no `SANDBOX_PROVIDER` in `infra/module/ctxpipe/railway.tf:337-367`, and its `Dockerfile.worker` neither runs Docker nor receives a daemon socket. It therefore selects Docker and fails before resolving every overlapping conflict; configuring the repository's `railway` value also fails explicitly. This contradicts the recovery plan (`docs/plans/workspace-chat-recovery.md:302-305`) and ADR-033:16, which require job resources to use the selected TanStack provider. Supply a provider usable by the hosted worker (and configure it in deployment), then add a contract for that deployed selection path.

### [P2] Do not fold unbounded job history inside the extraction transaction

`apps/backend/src/models/workspace-write-jobs.ts:522-540` selects every completed binding-matched payload and expands all maps in JavaScript. Because `loadExtractionProjectionSource` calls it inside the repeatable-read snapshot, transaction time and memory now grow with the workspace's entire export/extraction history. ADR-027:13 and ADR-033:20 require short org SQL transactions. Persist each completed result as a cumulative map and read the newest row, or compact assignments into a binding-keyed table/query with bounded output.

## Heuristic smell review

No additional Fowler smell rises to a finding. The semantic resource module is cohesive with ADR-033's explicit lifecycle, and the narrow, used Docker patch is not Speculative Generality.

## Verified

The two prior blockers are corrected: completed path maps fold oldest-to-newest across the full binding, and source/path/cutover reads share one repeatable-read transaction. Semantic input validation precedes paused persistence; re-admission does not mutate an existing command. Native merge preserves Git's clean tree, limits model replacement to the exact text-conflict paths, retains current-tip sole parenting, and destroys the resource before brokered push. The OpenAI-like transport uses its configured fetch. Declared unfinished Gate 3 work was excluded. I reviewed pinned blobs only and did not rerun the supplied 56-check/type evidence.
