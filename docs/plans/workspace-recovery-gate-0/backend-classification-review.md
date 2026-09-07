# Gate 0 backend test-classification review

Fixed source: `1fad8412525efdeefdfa4899fe9a2f41dfbbc1c8`. Inventory: 235 tracked backend test files. Every file was reviewed from its imports, suite/test descriptions, assertions, fixtures, and collaborator boundary; mock-name presence was used only as navigation. Each TSV row names representative asserted behavior and states the boundary rationale.

## Decisions

- **Proof: 119 files.** Pure public functions with independent literal oracles; real Postgres, git, Hono, logger, or local-process seams; and owned HTTP adapters where only the third-party service/SDK is substituted.
- **Characterization: 116 files.** Repository-owned models, stores, workflows, DB clients, queues, sandbox handles, or runtimes are replaced, or the test audits source/config shape. These preserve behavior and call choreography but cannot establish the integrated claim.
- **Redundant: 0 files.** No whole file was wholly tautological or fully duplicated. Some files overlap individual cases, but each retains at least one distinct invariant, so file-level deletion needs a deeper replacement proof first.

Owner counts: Gate 1 backend: 42, Gate 2 backend: 85, Gate 3 backend: 63, Gate 4 backend: 42, Gate 5 backend: 3.

## Boundary decisions

`rls-isolation`, `workspace-chat-persistence`, `workspaces-sandbox-persist`, and `ingestionRetraction.integration` use real migrated Postgres and are proof. `clone-tree` uses real git; `job-sandbox.live`, `tanstack-workspace-chat.live`, `tanstack-workspace-chat.multiturn`, and `conversation-files-routes.live` run the relevant local-process/TanStack/git seam and are proof even where their execution currently fails. Proof labels describe oracle strength, not green status.

External Linear, Notion, Slack, Forge, Bedrock, and model-provider adapters remain proof when their owned request lowering and response/error handling run and only the remote service/SDK is substituted. Tests become characterization when they mock a repository-owned model, workflow, store, codesearch client, sandbox provider, or route runtime.

## Blockers

The backend inventory is fully classified with no `UNCLASSIFIED`/`UNASSIGNED` rows. Gate 0 still needs classification merge/review across the other inventories and the already documented runtime, browser, journey, latency, flake, Docker-codesearch, and exact-checkpoint evidence. This review does not mark Gate 0 complete.
