# Standards review — `4a603c1992a0c69ce06efbb70e3e5b55d12c3a73`

**Pinned range:** `bb24210c01e0dc1bcbc2d4fdf197d07a7a17035d...4a603c1992a0c69ce06efbb70e3e5b55d12c3a73`
**Result:** 1 documented violation; 4 Fowler heuristic smells; 1 implemented-scope blocker.

## Documented-standard violation

1. **Linear’s GitHub webhook acknowledges a failed content enqueue.** `maybeActivateLinearSyncOnConfigPush` catches `enqueueConnectorContentSync` failure and only logs it (`apps/backend/src/routes/webhooks/github/github-linear-push.ts:143-156`). Control returns to `processPushEvent`, and both webhook routes return 200 (`github.ts:185-194,335-341,377-378`). The source-connectors rule says: **“ACK after OpenWorkflow enqueue. Failed enqueue → 5xx so the provider retries.”** A pre-owner database/OpenWorkflow failure can therefore lose the only config-push delivery. Let this error reach the webhook response; idempotency makes retry safe. **Blocker.** This is separate from the declared config-proposal crash/ACK gap.

The rest of the increment conforms to the documented rules. Shared content admission creates/re-discovers a native owner before activation and stores its ID (`openworkflow/enqueue-connector-content-sync.ts:17-76`; `models/connector-content-sync.ts:58-195`). Config/content workflows keep explicit durable steps; target capture and terminal projection use generation plus provider/repository/branch identity. `lockConnectorFinalizationBinding` now receives the caller’s transaction explicitly (`models/connector-finalization.ts:23-81`), satisfying the backend transaction rule and ADR-027. The owner migration is paired with its generated snapshot. Native tests use real HTTP/PostgreSQL/OpenWorkflow seams and remove owned-module mocks, consistent with TDD/mocking.

## Fowler heuristics (judgment calls)

- **Repeated Switches:** `connector-content-sync.ts:18-50,115-195,285-392` repeatedly branches on Confluence versus connection-backed providers for binding reads, activation, and terminal projection. A provider adapter/map could own those storage operations.
- **Duplicated Code:** GitHub installation lookup/token issuance remains duplicated (`models/github-installation.ts:721-742,778-804`).
- **Duplicated Code:** conversation preparation and publication route flows remain duplicated (`routes/v1/conversation-files-routes.ts:330-365,533-581`; `routes/v1/conversations.ts:652-705,747-863`).
- **Duplicated Code:** typed workspace admission still repeats parse → persist → bind → wake (`openworkflow/enqueue-workspace-write-commit.ts:217-358`). Connector admission duplication is closed by `enqueueConnectorContentSync`.

Declared event-ordering, config-proposal admission, legacy-helper, and other Gate 3 work was excluded. Evidence was inspected, not rerun.
