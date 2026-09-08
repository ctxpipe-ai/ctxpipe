# Gate 3 ingestion-owner checkpoint — Standards coverage

## Identity and method

- Repository: `/private/tmp/ctxpipe-recovery-01a07aba`
- Base: `bb24210c01e0dc1bcbc2d4fdf197d07a7a17035d`
- Reviewed: `c4caa83503c4ea1cd1648c86de6574f3107f8144`
- Merge base verified. The cumulative range has 30 commits and 1,770 paths. The increment after `c869ba820ad722a3c5936568a69d02baa1546bb9` has 110 paths: 25 production/migration, 10 tests, 67 evidence logs, and 8 other standards/status/config paths.
- Read-only review used `git diff BASE...PIN`, `git log BASE..PIN`, and `git show PIN:path`; the moving worktree and native test execution were excluded.

## Sources applied

- Root and backend `AGENTS.md`; code-review, TDD/mocking, and source-connectors skills.
- ADR-027/028 transaction rules, ADR-033 native ownership/replay rules, accepted ingest protocol, status and write-path audit.
- Full supplied Fowler baseline; repo rules override heuristics, and tooling-enforced matters were skipped.

## Changed surfaces and traced callers

- Generated `repository_ingestion_requests` migration/schema, migrate ordering, and metadata-only backfill: checked RLS, repository cascade, one current row, unique request key, captured URL/connection/branch/reason, latest legacy orchestrator selection, no enqueue, and conflict-preserving upgrade behavior.
- `models/repository-ingestion-requests.ts`: traced prepare/reuse, row locking, native owner lookup, API/first-step activation CAS, parent recovery for legacy children, source assertion, active-owner status fence, and SQL write predicate. All multi-statement ownership changes stay inside `withOrgDbContext`; no provider/Git/model I/O occurs there.
- `models/repository-ingestion-owners.ts` and repository selectors/mutators: checked bounded current-row/native-owner join, binding filters, pending/running/terminal projection, retained search warning, sanitized failure, cancellation, and request-fenced running/progress/ready writes.
- `enqueue-repository-ingestion.ts`, orchestrator, producer and follow-up: followed request identity from API reservation through idempotency key, lost-ack lookup, activation, native child parentage, extraction batch, broker rechecks before/after credential I/O, success, and awaited successor admission. Removed stale timeout/claim APIs and obsolete owned-mock tests have no production callers.
- All enqueue callers were enumerated: GitHub webhook, manual reindex, Linear/Notion parents, Slack, connector routes, repository creation, ensure-org-repository, native tests, and dynamic follow-up. Every production caller awaits except the two `void` route invocations reported in the main finding.
- Retraction changes: traced source-specific `claimIdentity`, encoded source generation, first-`#` parsing, percent fallback for legacy files, directory/file overlap, and ingestion request identity through acquisition, refresh, broker push, semantic handoff, cancellation, and supersession. Native tests cover hash-containing paths, per-source histories, directory evidence, late source changes, canceled/current/newer owners, warning retention, upgrade, restart, and follow-up reuse.
- Evidence claims inspected: 46 combined cases, six final owner/race cases, fresh/upgrade migration, 132 acknowledged type diagnostics, policy and scoped Biome. Results were reviewed, not rerun. Direct lost-ack transport injection and the other explicitly open Gate 3 inventory were not recast as checkpoint defects.

## Cumulative Fowler disposition

Rechecked all cumulative DB/Git/write-workflow, connector, ingestion/extraction, conversation publication, API/UI, migration and test surfaces. Seven prior judgments remain open: two Mysterious Name, one Repeated Switches, and four Duplicated Code. No new Feature Envy, Data Clumps, Primitive Obsession, Shotgun Surgery, Divergent Change, Speculative Generality, Message Chains, Middle Man, or Refused Bequest finding survived the documented-design override.
