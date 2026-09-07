# Gate 0 backend test-classification review

Fixed source: `1fad8412525efdeefdfa4899fe9a2f41dfbbc1c8`. Inventory: 235 tracked backend test files. Every file was reviewed from its imports, suite/test descriptions, assertions, fixtures, and collaborator boundary; mock-name presence was used only as navigation. Each TSV row names representative asserted behavior and states the boundary rationale.

## Decisions

- **Proof: 115 files.** Pure public functions with independent literal oracles; real Postgres, git, Hono, logger, or local-process seams; and owned HTTP adapters where only the third-party service/SDK is substituted.
- **Characterization: 120 files.** Repository-owned models, stores, workflows, DB clients, queues, sandbox handles, or runtimes are replaced, or the test audits source/config shape. These preserve behavior and call choreography but cannot establish the integrated claim.
- **Redundant: 0 files.** No whole file was wholly tautological or fully duplicated. Some files overlap individual cases, but each retains at least one distinct invariant, so file-level deletion needs a deeper replacement proof first.

Owner counts: Gate 1 backend: 42, Gate 2 backend: 85, Gate 3 backend: 63, Gate 4 backend: 42, Gate 5 backend: 3.

## Boundary decisions

`rls-isolation`, `workspace-chat-persistence`, `workspaces-sandbox-persist`, and
`ingestionRetraction.integration` use real migrated Postgres and are proof.
`clone-tree` uses real git; `job-sandbox.live` and
`tanstack-workspace-chat.multiturn` use the actual local process boundary.
The final adversarial review corrected four overclaims: checkout-read,
tanstack-workspace-chat.live, conversation-files-routes.live, and modelProvider
replace owned behavior and are now characterization. Their real process or SDK
portions remain useful diagnostics but do not prove the full owned boundary.
Proof labels describe oracle strength, not green status.

External Linear, Notion, Slack, Forge, Bedrock, and model-provider adapters remain proof when their owned request lowering and response/error handling run and only the remote service/SDK is substituted. Tests become characterization when they mock a repository-owned model, workflow, store, codesearch client, sandbox provider, or route runtime.

## Final review corrections

All 235 backend rows are classified. The initial review missed owned mocks in four
files; the final source audit corrected them as listed above. The complete TSV
now has 207 proof / 214 characterization across all 421 files, including the UI
mixed-file correction. Final exact-SHA gate approval is still required.
