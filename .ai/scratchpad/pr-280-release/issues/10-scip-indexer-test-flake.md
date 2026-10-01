# Flaky SCIP indexer serialization test

Status: needs-triage
Priority: P2
Owner: unassigned
Blocked by: none
Created: 2026-10-01
Updated: 2026-10-01

## Context

`apps/codesearch/src/domain/indexing/scipIndexers.test.ts` › "serializes default-output indexers per checkout and publishes after exit" hangs to the 5 s timeout about 1 run in 5 (observed 2026-10-01 after the main merge). Test and `scipIndexers.ts` are unchanged from `main`, so this is a `main` flake: likely a timing race between the module-global indexer process slot limiter and the per-checkout mutex across tests in the file.

## Plan (sketch)

1. Reproduce with `--repeat`/loop; find whether a previous test leaks a process slot or mutex tail.
2. Fix the race in code if real (preferred), otherwise make the test deterministic without retries; prove 50 clean runs.

## Comments

## Resolution
