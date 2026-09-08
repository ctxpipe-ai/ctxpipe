# Coverage ledger — Spec — `bb24210c...5136c873`

## Boundary and sources

- Fixed base `bb24210c01e0dc1bcbc2d4fdf197d07a7a17035d`; pinned target `5136c8734c433347786470a61589d64c4c3b3858`.
- Inspected the three-dot diff, complete commit log, and the target blobs through `git show`; ignored the moving checkout.
- Applied `docs/plans/workspace-chat-recovery.md:642-659`, locked tickets 10 and 14, and `.ai/memory/decisions/ADR-033-native-durable-write-workflows.md:7-32`. Used target `status.md:405-415` and `write-path-audit.md:1-30` only to distinguish checkpoint claims from declared remaining work.
- Read-only review; no repository edits or test processes.

## Previous findings replayed

- **Restored shallow branch:** `pushConversationSessionBranch` resolves both default and session tips, returns the unchanged remote session without a write credential, fetches the broker base directly, and transfers only the thin delta in bounded chunks (`conversation-publish.ts:155-290`). The new native cases create a real depth-one session clone that lacks the default SHA and cover unchanged and one descendant edit. These close the original `bad object` trigger. Finding 1 covers the untested, required rewritten-history topology.
- **Files-only warm:** `warmConversationSandbox` now calls `checkoutPreparedConversationBranch`, which persists the session branch and registers the handle plus URL/connection/generation/SHA/default metadata (`conversation-files-routes.ts:330-364,594-629`). The HTTP contract performs a real PUT with no prior attachment and then Push. The original missing-registration defect is closed.
- **PR identity:** generated migration `20260908175806_silent_whiplash` adds nullable `last_chat_pr_revision`; legacy numbers remain unbound. `persistConversationPublication` stores number and revision under an exact SHA/binding row lock (`models/conversations.ts:150-191`). Normal model reads null numbers whose generation/URL/connection/default no longer match (`:30-43`), and GET/POST verify the GitHub PR head equals `conversationSessionBranch` (`routes/v1/conversations.ts:722-749,822-849`). Static relink/collision and upgrade paths are covered. Finding 2 is the remaining multi-statement race.

## Connector finalization

- Traced the new `CapturedConnectorBinding` and `lockConnectorFinalizationBinding` through all three finalizers and their only production callers: Notion, Linear, and Confluence full-content workflows.
- The shared locked query validates workspace generation, URL, GitHub connection and default; repository ID/org, normalized URL and connection; and current provider kind/status plus Notion/Linear workspace ID or Confluence cloud/base URL (`connector-finalization.ts:9-75`). It intentionally omits desired SHA because the native mirror may advance the same binding.
- Each parent captures provider identity with the immutable mirror target before provider fetch, rechecks provider identity when loading transient credentials, and supplies the durable binding to finalization. Notion rejects a missing provider workspace ID. Existing target-row repository/branch/enabled/initial-sync predicates remain under the same transaction.
- PostgreSQL contracts exercise generation and provider-identity changes for all providers, plus completed/partial/failed projection. They do not interleave the derived directory write with a later connection update; finding 3 describes that uncovered boundary. Config activation identity and terminal setup failure remain explicitly open and were not reported.

## Remaining changed surface

- Reviewed removal of the unused PR counter and its callers/tests; the single deterministic session branch remains unchanged.
- Reviewed schema snapshot/migration, route schemas, fixture teardown changes, connector native test fixture identity additions, checkpoint evidence, status, and audit updates.
- No new default-branch writer, credential issuance path, or production caller of the changed public APIs appeared in this checkpoint. The wider write-path-audit inventory remains open and was excluded from findings.
