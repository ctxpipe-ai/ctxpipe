# Gate 3 source-budget checkpoint — Standards coverage

## Review identity and method

- Repository: `/private/tmp/ctxpipe-recovery-01a07aba`
- Base: `bb24210c01e0dc1bcbc2d4fdf197d07a7a17035d`
- Reviewed commit: `716a0a80a2679b74fb9a3dc1f18c57c93d3573a2`
- Merge base verified as the fixed base. The range contains 28 commits and 1,645 changed paths. The increment from `667ad146d4533f82488e2aac7d232ad9b416e52a` contains 54 paths: 18 production, 7 test, 22 evidence, and 7 documentation/review paths.
- Read only from `git diff BASE...PIN`, `git log BASE..PIN`, and `git show PIN:path`; the moving worktree was excluded. No tests or product files were run/changed.

## Standards read and applied

- Root and `apps/backend/AGENTS.md`: transaction ownership, domain/model boundaries, generated-schema ownership, validation, and backend test guidance.
- `.agents/skills/code-review/SKILL.md`: pinned review protocol, caller tracing, hard-rule versus heuristic separation, and exclusion of tooling-enforced issues.
- TDD `SKILL.md` and `mocking.md`: behavioral proof and owned-collaborator rules.
- Source-connectors guidance, with the accepted recovery plan/ADR-033 overriding the former mechanical `commitFiles` exception.
- ADR-027, ADR-028, ADR-033 and `docs/plans/workspace-recovery-gate-3/{status.md,write-path-audit.md}`.
- Full supplied Fowler baseline: Mysterious Name, Duplicated Code, Feature Envy, Data Clumps, Primitive Obsession, Repeated Switches, Shotgun Surgery, Divergent Change, Speculative Generality, Message Chains, Middle Man, Refused Bequest.

## Increment surface and caller tracing

- `domain/workspaces/extraction.ts`, `extraction-payload.ts`: traced the new count/byte budget into root captures, the final aggregate, enqueue parsing, stored job intent, typed workflow inputs, broker parsing, and semantic handoff parsing. Counts are checked before nested schemas and bytes use UTF-8 `Buffer.byteLength`.
- `capture-repository-extraction.ts`, `extraction-source.ts`: traced declaration path/blob capture through repository ingestion, extract-ingest admission, broker acquisition/refresh/no-op/push, and semantic child acquisition. Same-repository batches reject declarations; linked batches require an unchanged canonical declaration.
- `repository-ingestion.ts`, `runExtractRoot.ts`, extraction tests: inspected immutable batch assembly, per-root durable-step boundaries, aggregation, child invocation, restart proof, and oversize rejection proof. The final command cannot be admitted with an over-budget payload.
- `connector-mirror-input.ts`, `connector-mirror.ts`: traced pure Zod schemas/types into write-job intent, enqueue, mirror workflow, broker, and semantic merge; runtime DB readers remain in the model module, eliminating the schema/runtime import cycle.
- `write-command.ts`, `write-broker.ts`, `workspace-write-jobs.ts`, `workspace-semantic-merge.ts`: checked equality/persistence of extraction identity, direct-parent inheritance, retry/replay, no-op, and published lost-ack paths. A changed tip enters reconciliation; an already-published commit is acknowledged without reopening its immutable command.
- Deleted `retrievalObjectWrite.ts`, its runtime tests, graph reducers/projection/retraction exports, and `runExtractForRoot`; traced remaining references. Legacy fixture insertion moved to `src/test/legacy-extraction-fixture.ts`. Remaining similarly named fields belong to unrelated conversation graph state or historical native-step fixtures.
- Reviewed migrations/schema edits, ADR/status/audit updates, evidence logs, native repository-source/budget tests, extraction/semantic regressions, and removal of obsolete unit suites. The red log demonstrates oversized admission before the guard; green evidence records the corrected native behavior and the import-cycle correction.

## Cumulative changed-interface coverage

Rechecked the cumulative DB migrations/schema, revision and binding readers, Git pack/streaming helpers, write command/job models, admission and broker paths, all typed native workflows, connector parents, repository ingestion/extraction, semantic merge, conversation publication/API/UI capability, legacy recovery CLI, and their native/contract/unit callers. Previously reported hard findings remain closed. The seven surviving cumulative heuristic judgments are listed in the main report; all other Fowler categories produced no actionable implemented-scope finding.

Explicitly open plan/audit work (including canonical retraction, complete endpoint/producer recovery, configuration event ordering, unborn bootstrap, and older audit inventory) was recorded as acceptance inventory rather than misreported as a defect in this checkpoint.
