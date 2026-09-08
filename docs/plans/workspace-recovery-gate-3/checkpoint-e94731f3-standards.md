# Standards review — `e94731f310ff539fe86bb5499e6c691256e48b41`

**Pinned range:** `bb24210c01e0dc1bcbc2d4fdf197d07a7a17035d...e94731f310ff539fe86bb5499e6c691256e48b41`
**Result:** 0 documented violations; 3 Fowler heuristic smells; 0 implemented-scope blockers.

## Documented standards

No breach found. The prior API-contract violation is closed: `publicConversation` parses through `ConversationSchema`, stripping the internal revision while deriving the PR URL from its saved repository (`apps/backend/src/routes/v1/conversations.ts:71-110`), and GET PR rechecks the paired number/binding after provider I/O (`:707-736`). This satisfies the backend Zod/OpenAPI rule.

The new ownership code also follows ADR-027/033. Directory projection locks and re-reads the current tenant row in the same short transaction as its un-RLS directory write (`models/connection-directory.ts:46-77`). Full-sync capture checks the native input generation before Git I/O (`domain/workspaces/capture-connector-mirror.ts:20-58`); finalizers compare that generation with repository, workspace and provider identity under SQL locks (`models/connector-finalization.ts:9-80`). Terminal-owner projection and admission reconciliation are generation-scoped and contain only SQL (`models/connector-content-sync.ts:21-75`). Confluence marker projection uses the same binding lock. No SQL transaction spans Git, provider, or model I/O.

The native HTTP/webhook/model/OpenWorkflow tests exercise owned collaborators; removed tests were owned-module mocks, consistent with `tdd/mocking.md`. Committed evidence was inspected, not rerun. The declared activation/admission crash interval, event ordering, and Confluence no-change lifecycle remain open scope and are not checkpoint findings.

## Fowler heuristics (judgment calls)

- **Duplicated Code:** credential acquisition still repeats installation lookup, row load, app construction and token authentication in `getInstallationOctokitForOrg` and `getInstallationToken` (`models/github-installation.ts:721-742,778-804`). Share the credential issuance core.
- **Duplicated Code:** explicit Prepare duplicates `warmConversationSandbox`, and Files push/PR creation duplicate capture → plan → publish (`routes/v1/conversation-files-routes.ts:330-365,533-581`; `routes/v1/conversations.ts:652-705,747-863`). Extract the two route-neutral domain operations.
- **Duplicated Code:** write admission repeats parse → persist → bind → wake across the kind arms (`openworkflow/enqueue-workspace-write-commit.ts:217-358`); the new connector admission sites repeat generation → enqueue → reconcile (`enqueue-*-push-sync.ts` and connector retry/webhook routes). Share these non-workflow admission shapes without hiding ADR-033’s explicit workflow steps.
