# Standards review — `a7129f1973caea687ae3420fc2e36fe730dd8fa8`

**Pinned range:** `bb24210c01e0dc1bcbc2d4fdf197d07a7a17035d...a7129f1973caea687ae3420fc2e36fe730dd8fa8`
**Result:** 1 documented violation; 6 Fowler heuristic smells; 1 implemented-scope blocker.

## Documented-standard violation

1. **[P1] The shared connector owner bypasses the canonical provider config schemas.** `readBinding` reads `connection.config` directly and redefines its defaults (`apps/backend/src/models/connector-content-sync.ts:18-50`); activation and reconciliation spread raw JSON back into the column (`:253-273,435-443,482-489`). Source-connectors §2 requires: **“Read/write config only through a colocated Zod schema in `apps/backend/src/lib/connection-config.ts`.”** This produces a concrete compatibility failure: the Linear and Notion schemas default an omitted `enabled` to `true` (`connection-config.ts:128-157,286-303`), whereas `readBinding` treats it as false. Such valid legacy rows are rejected by `prepareConnectorSync`, so the newly implemented scoped recovery can silently omit exactly the rows it is meant to repair. Parse with the provider schemas and serialize/merge through their canonical helpers (or delegate storage projection to the provider models). **Blocker.**

The prior Linear webhook blocker is closed: the catch now rethrows (`routes/webhooks/github/github-linear-push.ts:143-157`). Owner-first enqueue, first-step recovery, immutable scope input, terminal projection, generation-fenced finalization, and the bounded explicit recovery CLI otherwise match ADR-033 and the transaction rules. No SQL scope spans provider, Git, or workflow I/O. Native proofs replace owned-module mocks.

## Fowler heuristics (judgment calls)

- **Mysterious Name:** `contentSyncWorkflowRunId` now owns config and content runs (`connections.ts:39`; `connector-content-sync.ts:154-288`). Rename it to the actual shared concept or split the owners.
- **Repeated Switches:** provider/storage dispatch recurs across `connector-content-sync.ts:18-50,154-288,377-493`; use provider-owned adapters.
- **Duplicated Code:** config and content enqueue repeat prepare → idempotent run/recovery → activate (`enqueue-connector-{config,content}-sync.ts`).
- **Duplicated Code:** GitHub installation/token setup remains duplicated (`github-installation.ts:721-742,778-804`).
- **Duplicated Code:** conversation preparation/publication remains duplicated (`conversation-files-routes.ts:330-365,533-581`; `conversations.ts:652-705,747-863`).
- **Duplicated Code:** typed workspace admission still repeats parse → persist → run (`enqueue-workspace-write-commit.ts:217-358`).

Declared unfinished Gate 3 work was excluded. Evidence was inspected, not rerun.
