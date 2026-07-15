---
name: Deterministic Libraries Prepass
overview: Add a deterministic manifest-based prepass to identify architectural libraries across multiple ecosystems in `identifyLibraries`, and invoke the existing LLM agent only for ambiguous or unresolved cases.
todos:
  - id: design-prepass
    content: Design manifest discovery + parser map and ambiguity criteria for library detection
    status: pending
  - id: implement-prepass
    content: Implement deterministic prepass and conditional LLM fallback in identifyLibraries
    status: pending
  - id: merge-and-provenance
    content: Merge deterministic and fallback outputs with correct extractionMethod/provenance
    status: pending
  - id: tests
    content: Expand identifyLibraries tests for every supported ecosystem + fallback behavior
    status: pending
  - id: verify
    content: Run full targeted backend tests/lints after TDD red-green-refactor cycle
    status: pending
isProject: false
---

# Deterministic-first library detection plan

## Goal

Update `[/Users/vietanhtran/Projects/Appear/ctxpipe/apps/backend/src/graphs/codeIngestionGraph/nodes/identifyLibraries.ts](/Users/vietanhtran/Projects/Appear/ctxpipe/apps/backend/src/graphs/codeIngestionGraph/nodes/identifyLibraries.ts)` so library extraction is deterministic-first (manifest scan across ecosystems) with LLM fallback only when deterministic signals are ambiguous/incomplete.

## Implementation steps

- Use strict TDD (red-green-refactor) for this change:
  - Write/extend failing tests first for deterministic manifest detection and fallback behavior.
  - Implement the minimum production code required to make tests pass.
  - Refactor parser/mapping logic only after tests are green, preserving behavior.
- Add a deterministic prepass in `[/Users/vietanhtran/Projects/Appear/ctxpipe/apps/backend/src/graphs/codeIngestionGraph/nodes/identifyLibraries.ts](/Users/vietanhtran/Projects/Appear/ctxpipe/apps/backend/src/graphs/codeIngestionGraph/nodes/identifyLibraries.ts)`:
  - Use codesearch file APIs (`listFilesRecursive` + `fetchFiles`) to discover and read ecosystem manifests under each resolved root.
  - Parse dependency declarations for major ecosystems (Node/Bun, Ruby, Python, Go, Java/Kotlin, Rust, PHP, .NET, Elixir, Swift).
  - Map known package names to canonical architectural libraries + category (ORM/HTTP/auth/validation/cache/RPC).
- Introduce explicit ambiguity rules for fallback:
  - Deterministic result is **confident** when at least one architectural library is identified with direct manifest evidence and no unresolved manifest parse failures for that root.
  - Mark root as **ambiguous** when manifests are present but parsing fails, or when only weak/non-canonical signals are found.
  - Run the existing LLM agent only for ambiguous roots (instead of always running).
- Merge deterministic + LLM submissions in one post-process pipeline:
  - Keep existing normalization/dedup via `normalizeLibraryName` and `postProcessLibraries`.
  - Attach provenance evidence indicating deterministic manifest path/package source when prepass finds a library.
  - Preserve partial-ingestion filtering behavior via existing partial-scan helpers before post-processing.
- Update extraction metadata semantics in output claims:
  - Keep `sourceType: "git"`.
  - Set `extractionMethod` based on evidence origin (`"deterministic"` for manifest prepass hits, `"llm"` for fallback hits), while preserving current keying/dedup behavior.
- Keep LLM prompt focused on ambiguity resolution:
  - Narrow prompt/user message for fallback runs so the model resolves only unclear roots/signals, reducing token usage and false positives.
  - Retain current recursion/context limits.

## Test updates

- Extend `[/Users/vietanhtran/Projects/Appear/ctxpipe/apps/backend/src/graphs/codeIngestionGraph/nodes/identifyLibraries.test.ts](/Users/vietanhtran/Projects/Appear/ctxpipe/apps/backend/src/graphs/codeIngestionGraph/nodes/identifyLibraries.test.ts)` with deterministic-prepass unit tests:
  - Node/Bun: `package.json` dependencies produce expected libraries.
  - Ruby: `Gemfile` gems map correctly.
  - Python: `requirements.txt` and `pyproject.toml` dependency declarations map correctly.
  - Go: `go.mod` requirements map correctly.
  - Java/Kotlin: `pom.xml`, `build.gradle`, and `build.gradle.kts` dependencies map correctly.
  - Rust: `Cargo.toml` dependencies map correctly.
  - PHP: `composer.json` dependencies map correctly.
  - .NET: `*.csproj` package references map correctly.
  - Elixir: `mix.exs` deps map correctly.
  - Swift: `Package.swift` package dependencies map correctly.
  - Ambiguous manifest parse triggers fallback path.
  - Deterministic-only path skips agent invocation.
- Add/adjust tests for claim extraction method:
  - Verify deterministic findings produce `extractionMethod: "deterministic"`.
  - Verify fallback findings remain `"llm"`.
  - Verify mixed deterministic + fallback results preserve per-claim extraction method and evidence provenance.

## Minimum acceptance matrix

- Node/Bun: `package.json` includes `prisma` or `drizzle-orm` -> emits `Prisma`/`Drizzle` with category `ORM`.
- Ruby: `Gemfile` includes `rails` or `sinatra` -> emits `Rails`/`Sinatra` with category `HTTP`.
- Python: `requirements.txt` or `pyproject.toml` includes `fastapi`/`flask`/`django` -> emits canonical HTTP framework with category `HTTP`.
- Go: `go.mod` includes `github.com/gofiber/fiber` or `github.com/go-chi/chi` -> emits `Fiber`/`Chi` with category `HTTP`.
- Java/Kotlin: `pom.xml` or `build.gradle(.kts)` includes `org.springframework.boot` -> emits `Spring Boot` with category `HTTP`.
- Rust: `Cargo.toml` includes `axum` -> emits `Axum` with category `HTTP`.
- PHP: `composer.json` includes `laravel/framework` or `symfony/framework-bundle` -> emits `Laravel`/`Symfony` with category `HTTP`.
- .NET: `*.csproj` includes `Microsoft.AspNetCore.App` or `Microsoft.EntityFrameworkCore` -> emits `ASP.NET Core` (`HTTP`) or `Entity Framework` (`ORM`).
- Elixir: `mix.exs` includes `phoenix` or `ecto` -> emits `Phoenix` (`HTTP`) or `Ecto` (`ORM`).
- Swift: `Package.swift` includes `vapor` -> emits `Vapor` with category `HTTP`.
- Ambiguity guard: malformed manifest content (invalid JSON/TOML/XML or unsupported structure) causes deterministic parser to mark root ambiguous and trigger LLM fallback.
- Fallback guard: when deterministic evidence is sufficient and unambiguous, agent fallback is not invoked.

## Key files to touch

- `[/Users/vietanhtran/Projects/Appear/ctxpipe/apps/backend/src/graphs/codeIngestionGraph/nodes/identifyLibraries.ts](/Users/vietanhtran/Projects/Appear/ctxpipe/apps/backend/src/graphs/codeIngestionGraph/nodes/identifyLibraries.ts)`
- `[/Users/vietanhtran/Projects/Appear/ctxpipe/apps/backend/src/graphs/codeIngestionGraph/nodes/identifyLibraries.test.ts](/Users/vietanhtran/Projects/Appear/ctxpipe/apps/backend/src/graphs/codeIngestionGraph/nodes/identifyLibraries.test.ts)`
- (If needed for maintainability) a small helper in the same `nodes/` area for manifest parsing, covered by unit tests.

## Verification

- Run tests in TDD order: failing tests first, then implementation, then green run.
- Run backend targeted tests for this node and nearby ingestion tests.
- Confirm deterministic path captures common ecosystems and that LLM is only invoked for ambiguous roots/signals.

