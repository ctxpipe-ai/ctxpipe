# ADR-056: Oxlint and Oxfmt replace Biome

**Status:** Accepted | **Date:** 2026-10-25 | **Tags:** tooling, lint, format, oxc

## Context

Biome did the lint and the format for the monorepo. The check tooling of the repo already uses the Oxc parser. A second parser ecosystem means a second set of syntax rules, a second set of bugs, and a second tool to update. Biome ran its recommended rule set, and it also ran its CSS rules. Biome did not check the format in CI, so most files were never formatted.

## Decision

1. **Oxlint does the lint, and Oxfmt does the format.** Biome is removed. The repo has one parser ecosystem (Oxc) for the lint, the format, and the check tooling.
2. **Parity with Biome is the rule.** Oxlint turns on each Biome recommended rule that has an Oxlint equivalent. Where Oxlint is stricter and old code fails, a per-file entry in `.oxlintrc.json` keeps that file out of the rule until someone fixes it. A line-level `oxlint-disable-next-line` comment with a reason replaces each line-level `biome-ignore` comment.
3. **CI checks the lint and the format.** `pnpm lint` and `pnpm format:check` must pass. Biome never checked the format, so one repo-wide Oxfmt reformat brought every file to the same style. Each author formats the files that they change with `pnpm format`.
4. **Rule gaps are recorded, not silent.** These Biome rules have no Oxlint equivalent that works without type information, or have an equivalent with a different meaning:
   - `useOptionalChain`, `useExportType`: Oxlint needs type information for these, and type-aware lint is not in use.
   - `noImplicitAnyLet`: the TypeScript compiler with `noImplicitAny` reports the same code.
   - `noRedeclare`, `noInvalidUseBeforeDeclaration`: the TypeScript compiler reports the same code. The Oxlint rules give false positives on a type and a value with the same name.
   - `noSvgWithoutTitle`, `noEmptyTypeParameters`, `noFlatMapIdentity`, `noThisInStatic`, `noUselessContinue`, `noUselessStringRaw`, `useSimpleNumberKeys`, `noStringCaseMismatch`, `noVoidTypeReturn`, `noConfusingLabels` (loop and switch labels stay allowed), `noDynamicNamespaceImportAccess`, `noDocumentCookie`, `noRedundantUseStrict`, `noSuspiciousSemicolonInJsx`, `useDeprecatedReason`: no Oxlint rule.
   - Test rules (`noFocusedTests`, `noDuplicateTestHooks`, `noExportsInTest`): the Oxlint test plugin brings many extra rules, so it is not on. Vitest already fails a `.only` in CI.
   - Biome-only rules (`noBiomeFirstException`, `noQuickfixBiome`, `useBiomeIgnoreFolder`) end with Biome.
5. **CSS is not linted.** The Biome CSS rules gave no error in this repo. The only findings were `noImportantStyles` warnings, and these did not fail CI. Oxlint has no CSS rules. The UI uses Tailwind only, so no CSS linter is needed.

## Consequences

- One tool family to update, and one parser for lint, format, and checks.
- The lint is as strict as Biome was for each mapped rule, and stricter for some rules. The per-file entries list the code that still fails. Remove a file from an entry when you fix the code.
- A rule in the gap list gets no automatic check. Add a rule to Oxlint, or add a tool, to close a gap.
- The hook rules (`rules-of-hooks`, `exhaustive-deps`) cover every `.tsx` and `.jsx` file, and every file in `apps/ui`.
- The instruction-area skill recognizes `oxlint-disable` as a suppression, and it still recognizes `biome-ignore` for repos that ctxpipe imports.
