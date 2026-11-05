# ADR-060: The Typecheck check runs `bun check`

**Status:** Accepted | **Date:** 2026-11-05 | **Tags:** ci, typescript, bun, tooling

## Context

The Typecheck check ran the TypeScript 6 compiler through its JavaScript API, with an incremental build-info cache. A cold run of the two large projects took about 30 s each on a laptop, and about 3.5 minutes for all projects in CI. Bun 1.4.3 added `bun check`, a type checker that ports the native TypeScript compiler. It reads the same `tsconfig.json`, reports the same diagnostics as TypeScript 7, and does not emit files. On this repository it gave identical diagnostics to the TypeScript 6 compiler (same file, line, and code), on the tree and on a set of injected errors, and a cold run took seconds.

## Decision

1. The Typecheck check runs `bun check --no-script --no-pretty` for each project and compares the diagnostics with the allowance of the project. The Bun version is pinned in CI and is part of the result key of the check.
2. TypeScript 6 stays the `typescript` dependency. The package builds, the emit steps, the editors, and the scripts that import the TypeScript API still use it.
3. The check has no cache. A cold run is fast enough.
4. The allowance of a project compares the file, the error code, and the count. The message text belongs to the checker that wrote it, so a checker change may rewrite it, and the history check ignores the text of a diagnostic entry.

## Consequences

- A checker that no other tool in the repository uses decides if the types are correct. A new Bun release can change a diagnostic. The pin makes that change a reviewed change.
- The Typecheck job needs Bun, and it needs no build-info cache.
- The check reports declaration errors for a project that sets `declaration`, which the TypeScript 6 command line did not report without emit.

## Alternatives considered

- **The TypeScript 7 `tsc` or `tsgo`.** About 1.3 times faster than TypeScript 6 on a cold run of the large projects, and slower in CPU time, so only a warm build-info run gains.
- **Run both checkers.** It keeps the old cost and the old cache for a safety net that the identical results do not need.
