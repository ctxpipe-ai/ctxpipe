# ADR-045: CI proves what ran

**Status:** Accepted (revised 2026-10-02) | **Date:** 2026-09-08 | **Tags:** ci, testing

## Context

Before PR 280's recovery, CI filtered TypeScript diagnostics by path, excluded database and OpenCode tests, and built packages with `tsc --noEmit`. A green run did not say which product paths executed.

## Decision

- **Typecheck** every project in `scripts/ci/projects.json` with its real compiler configuration and print all diagnostics. Known diagnostics live in `scripts/ci/diagnostics/<project>.json`; git history must show those allowances only shrink.
- **Tests** run from an inventory with Vitest's structured results. A missing file, empty suite, skip, todo, or unexpected failure fails CI; known failures need exact entries in `scripts/ci/failures/` (currently none). The test-policy check rejects test selection modifiers, expected-failure tests, retries, and mocks of our own modules in proof tests; third-party SDK and network boundaries may be faked (MSW, SDK mocks on an allowlist).
- **Contract lanes** (`scripts/ci/contracts.json`) run real collaborators: migrated Postgres as the `ctxpipe_app` role, native git, OpenWorkflow, hydrate, the chat engine with a scripted model upstream and a real OpenCode binary, sandbox ownership, and codesearch with real indexers (Node and Bun).
- **Builds**: production images (backend, worker, UI, codesearch, docs) build without publishing; CDK and CLI packages build and the self-host example typechecks; Terraform validates without credentials.
- **UI journeys**: Storybook `play` functions tagged `workspace-golden` run in Chromium; a missing or skipped required play fails CI.
- **Migrations** apply on a fresh database and on the previous schema.

## Consequences

CI is slower and needs Postgres, Bun, OpenCode and Docker, but a green run means the listed paths executed. Allowances are debt to burn down, never a way to add regressions.
