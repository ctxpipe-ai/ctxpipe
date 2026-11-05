# ADR-060: The Typecheck check runs `bun check`

**Status:** Accepted | **Date:** 2026-11-05 | **Tags:** ci, typescript, bun, tooling

## Context

The Typecheck check ran the TypeScript 6 compiler through its JavaScript API. It kept an incremental build-info cache, and a cold run was slow. Bun 1.4.3 added `bun check`. It ports the native TypeScript compiler. It reads the same `tsconfig.json` and does not emit files.

## Decision

1. The Typecheck check runs `bun check --no-script --no-pretty --all` for each project. It compares the diagnostics with the allowance of the project. The Bun version is pinned in CI and is part of the result key of the check. The `bun` prerequisite requires the version in `engines`.
2. TypeScript 6 stays the `typescript` dependency. The package builds, the emit steps, the editors, and the scripts that import the TypeScript API still use it.
3. The check has no cache.
4. An allowance identifies a diagnostic by its file and its error code, with a count. The message text belongs to the checker that wrote it. A checker change may rewrite it, so the runner and the history check ignore it. The message is only for the report.
5. The check never passes on output that it cannot trust. The summary line that Bun prints on stderr must exist. The error count in the summary must equal the number of diagnostics that the runner parsed. The summary must show at least one checked file. The exit code must agree with the error count. Every line of stdout must be part of a diagnostic. Bun stops before it checks types when the configuration or a file has a syntax error. The output then says so, and the check fails.

## Consequences

- A checker that no other tool in the repository uses decides if the types are correct. A new Bun release can change a diagnostic. The pin makes that change a reviewed change.
- The Typecheck job needs Bun, and it needs no build-info cache.
- The check reports declaration errors for a project that sets `declaration`. The TypeScript 6 command line did not report them without emit.
- A new Bun output format fails the check until the runner is updated. This is deliberate.

## Alternatives considered

- **The TypeScript 7 `tsc` or `tsgo`.** It gains speed only with a warm build-info cache, and it costs more CPU time on a cold run.
- **Run both checkers.** It keeps the old cost and the old cache for a safety net that the identical results do not need.
