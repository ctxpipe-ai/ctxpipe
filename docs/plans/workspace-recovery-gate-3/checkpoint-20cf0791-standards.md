# Gate 3 final CI-fixture correction — Standards review

Pinned increment: `f7c354334bb91310f3a49f74563bce6497c688ca...20cf0791c4467aacd5719ad58ee39593515300eb`. The cumulative closure review and caller/search ledger are retained. CI for this exact pin is pending, so this report does not itself declare Gate 3 closed.

## Documented-standard violations

None.

The stale Notion fixture is corrected without changing production code. Production derives its admission identity from `connectorConfigKey(renderNotionConfigYaml(scopeFromRepo))` (`enqueue-notion-push-sync.ts:25-30`). The canceled-owner fixture now uses that same canonical value in both the idempotency key and immutable workflow input (`enqueue-notion-push-sync.test.ts:67-95`). It therefore cancels the owner that the production path actually finds, rather than an owner keyed by the obsolete JSON representation.

The behavioral proof remains intact: the native test invokes the real enqueue path, observes `sync_failed` after the canceled owner, explicitly retries, observes `initial_sync`, requires exactly two owners, and checks that the pending replacement has generation 2 (`enqueue-notion-push-sync.test.ts:96-130`). This is consistent with the repository rule that workflow/Git proof use real infrastructure instead of mocks (`apps/backend/AGENTS.md:23`) and the root TDD mandate (`AGENTS.md:46`). The committed focused log records both parameterized native cases passing.

The exact delta contains one five-line/two-line test adjustment plus documentation and evidence. It changes no schema, workflow, SQL, Git, credential, or production interface.

## Fowler heuristics

No new judgment. Retained nonblocking backlog: **Mysterious Name (2), Repeated Switches (1), Duplicated Code (6)**.

**Counts:** 0 documented violations / 0 blockers; 9 retained nonblocking heuristics.
