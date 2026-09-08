# Standards review — `5136c8734c433347786470a61589d64c4c3b3858`

**Pinned range:** `bb24210c01e0dc1bcbc2d4fdf197d07a7a17035d...5136c8734c433347786470a61589d64c4c3b3858`
**Result:** 1 documented violation; 4 heuristic smells; 0 blockers.

## Documented-standard violation

1. **Conversation responses expose an undocumented internal binding field.** `conversationSelection` spreads every conversation column, including the new `lastChatPrRevision` JSON, while only overriding `lastChatPrNumber` (`models/conversations.ts:30-44`). List, detail, and patch responses then spread that row into JSON (`routes/v1/conversations.ts:459-476,500-521,566-576`), but `ConversationSchema` does not declare `lastChatPrRevision` (`:67-84`). This makes the versioned API payload disagree with its Zod/OpenAPI contract, contrary to `apps/backend/AGENTS.md:5-6`. Select/map only the public fields, keeping the revision solely as a projection predicate.

The restored publisher otherwise conforms to ADR-033: it uses the remote session tip as the thin-pack base, rejects non-ancestor tips, and turns an already-published tip into a read-only no-op (`conversation-publish.ts:151-218`). Lazy Files warming now performs the same captured registration as Prepare (`conversation-files-routes.ts:330-365`). PR state is revision-bound, connector finalizers share `CapturedConnectorBinding`, and their workspace/repository/connection locks remain inside short model-owned transactions.

## Fowler heuristic smells (judgment calls)

- **Mysterious Name:** `conversationSelection` hides the crucial current-binding PR filter. Rename it to state that policy (`models/conversations.ts:30-44`).
- **Duplicated Code:** Prepare and lazy warming duplicate warm → checkout/capture, while push and PR duplicate capture → plan → publish (`conversation-files-routes.ts:330-365,546-579`; `conversations.ts:685-719,781-837`). Share the two domain operations.
- **Duplicated Code (remaining):** scoped token construction still recurs in `getInstallationOctokitForOrg` and `getInstallationToken` (`github-installation.ts:721-819`).
- **Duplicated Code (remaining):** typed admission arms repeat parse → persist → bind → wake → return (`enqueue-workspace-write-commit.ts:217-358`).

The prior connector **Data Clumps** finding is closed by `CapturedConnectorBinding`. Committed evidence was inspected, not rerun; declared config-activation and terminal-failure work was excluded.
