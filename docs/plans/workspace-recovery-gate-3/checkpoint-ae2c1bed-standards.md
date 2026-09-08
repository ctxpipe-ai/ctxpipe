# Standards review — `ae2c1bed69cea1c6724b05d8ae1ce7a659465b42`

**Pinned range:** `bb24210c01e0dc1bcbc2d4fdf197d07a7a17035d...ae2c1bed69cea1c6724b05d8ae1ce7a659465b42`
**Result:** 1 documented violation; 9 Fowler heuristic smells; 1 implemented-scope blocker.

## Documented-standard violation

1. **[P2] Equivalent Confluence proposals can still be rejected as competing.** The shared Git/config canonicalizer converts empty `selectedPageIds` to `null` (`apps/backend/src/services/confluence/config-yaml.ts:51-63`), but the pending-proposal comparator independently preserves `[]` (`models/atlassian-connector.ts:887-907`). The route applies that comparison before shared admission (`routes/v1/connectors-atlassian.ts:970-1018`), so resubmitting the same rendered config with `null` versus `[]` returns 409 instead of reusing its owner. That contradicts ADR-033’s requirement that repeated config events reuse the current owner and undercuts this checkpoint’s canonical proposal identity. Use the same canonical selection function for both comparison and key generation. **Blocker.**

The prior config-schema blocker is closed: shared reads use the Linear, Notion, and Forge parsers, and lifecycle writes use canonical serializers (`models/connector-content-sync.ts:26-97,299-318,480-535`). The extraction slice otherwise follows ADR-033: strict immutable input is stored in intent and native input, replay compares it, content comes only from the batch plus acquired Git, and PostgreSQL supplies only binding-scoped path/cutover metadata (`domain/workspaces/extraction.ts:4-35`; `workflows/workspace-extract-ingest.ts:44-185`). No SQL scope spans Git/provider/workflow I/O; tests use real owned collaborators.

## Fowler heuristics (judgment calls)

- **Duplicated Code:** the two Confluence selection normalizers above have already diverged.
- **Feature Envy:** extraction-to-projection conversion reaches through every batch field inside workflow orchestration (`workspace-extract-ingest.ts:131-168`); move the pure adapter beside `workspaceExtractionSchema`.
- **Mysterious Name:** `sourceId` becomes `evidenceKey` (`extraction.ts:28`; workflow `:162`); name the durable concept consistently.
- **Mysterious Name:** `contentSyncWorkflowRunId` owns config and content runs (`connections.ts:39`; `connector-content-sync.ts:200-333`).
- **Repeated Switches:** provider/storage dispatch remains in `connector-content-sync.ts:26-97,200-333,423-538`.
- **Duplicated Code:** config/content enqueue still repeat prepare → run recovery → activate.
- **Duplicated Code:** GitHub installation/token setup remains duplicated (`github-installation.ts:721-742,778-804`).
- **Duplicated Code:** conversation prepare/publication remains duplicated (`conversation-files-routes.ts:330-365,533-581`; `conversations.ts:652-705,747-863`).
- **Duplicated Code:** typed workspace admission still repeats parse → persist → run (`enqueue-workspace-write-commit.ts:217-379`).

Declared unfinished producer/retraction/bounds/recovery and other Gate 3 work was excluded. Evidence was inspected, not rerun.
