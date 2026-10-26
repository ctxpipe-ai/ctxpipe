# Check manifest and runner

These commands are the public check contract. A tool that selects checks (for example the factory `factory check` command) uses only these commands. It does not make a Vitest, Playwright or pnpm command line itself.

## Commands

- `pnpm -s checks:list` prints the manifest as one JSON object: `{ schemaVersion, checks }`. The schema is [`schema/manifest.v1.schema.json`](schema/manifest.v1.schema.json).
- `pnpm -s checks:run [--trace <dir>] [ids-file]` runs the given check ids. Without `ids-file`, it reads the ids from stdin, one id on each line. It first makes or verifies the prerequisites of the checks (see Prerequisites). It writes one JSON line for each id to stdout. Each line has `schemaVersion`. The schema is [`schema/result.v1.schema.json`](schema/result.v1.schema.json). The output of the checks goes to a log in `.ci-results/checks/` (the `log` of each record): `<lane>.log` for a Vitest lane, `<family>-<lane>.log` for a project check, `storybook.log` and `eval-mcp.log`. The exit code is 1 when a check fails or does not run.
- `pnpm -s checks:prepare <name>...` makes or verifies the named prerequisites. It writes `ready <name>` or `failed <name>: <cause and fix>` for each name. The exit code is 1 when one fails.

## Check ids

A check id is `<family>:<lane>:<file>`, for example `vitest:ui:apps/ui/src/components/ui/Button.test.tsx`. The file is relative to the repo root. A check of one case of a file has the id `<family>:<lane>:<file>#<case>`. Thus a file id is always a prefix of the ids of its cases.

## Families

| Family | Lanes | One check for each | Id example | Runs |
| --- | --- | --- | --- | --- |
| `vitest` | `backend`, `contracts`, `vercel`, `ui`, `cli`, `aws-cdk`, `codesearch`, `codesearch-bun`, `latency`, `upgrade` | test file | `vitest:ui:apps/ui/src/components/ui/Button.test.tsx` | Vitest, see Lanes |
| `storybook` | `golden` (tag `workspace-golden`), `plays` (the other stories) | story with a play function | `storybook:golden:apps/ui/src/…/X.stories.tsx#<story id>` | the static Storybook build in Chromium, with [`../ci/storybook-play.mjs`](../ci/storybook-play.mjs) |
| `eval` | `mcp` (MCPJam, `apps/backend/evals/mcp/cases.ts`), eval case | `eval:mcp:apps/backend/evals/mcp/cases.ts#stale-cursor` | one seed and one `evals/mcp/run.ts` run for the selected cases |
| `typecheck` | the `name` of each project in `scripts/ci/projects.json` | project | `typecheck:ui:apps/ui/tsconfig.json` | `scripts/ci/typecheck.mjs` with the project's diagnostic allowances |
| `lint` | `oxlint`, `format`, `knip` | tool | `lint:knip:knip.json` | `pnpm lint`, `pnpm format:check`, `pnpm knip` |
| `policy` | the name of each policy script of the CI lint job | script | `policy:test-policy:scripts/ci/check-test-policy.mjs` | that script |

- A Storybook story is a case of its stories file. The story id is the Storybook id, so the id stays the same when the story moves in its file. [`storybook.mjs`](storybook.mjs) lists the stories with the Storybook indexer (`buildIndex`), and runs them against `apps/ui/storybook-static`.
- An eval case calls paid models. The record has `stochastic: true`: the same inputs can give a different result, so a result cache must not reuse it. Its inputs are only its harness. `tools` lists the MCP tools that the case declares. A reader selects the case by those tools and the trace's `tools` edges (the tools that each Vitest case called), then by its `intent`. A reader never selects it by an import. The verdict of a case is the eval gate (`apps/backend/evals/mcp/gate.ts`) for that one case: its thresholds and the baseline drop for the case. When a model has no baseline entry for the case, only the pass-rate floor applies, and the case message says "no baseline". A whole-run gate failure (for example, too few models) does not change the verdict of a case. The runner writes it to stderr as one note. The memory live evals have no check; each scenario is listed when a live runner can run it.
- The `latency` and `upgrade` lanes run the files that the PR suite does not run (`*.latency.ts`, `*.upgrade.ts`), each with its own Vitest config. A latency result is `stochastic`: wall-clock bounds vary on shared runners.
- The `typecheck`, `lint` and `policy` checks run a fixed command over a whole project, so they have no trace. Their `inputs` approximate the files that they read with whole directories (for example `apps/**` for oxlint, and `apps/backend/src/**` for the UI typecheck, because the UI types import the backend RPC types). A change in one of them selects the check. Their `root` is the repo root (`""`) or the project directory.

## Intent

An expensive check states what it catches, and what is never a reason to run it, in `intent` (under about 40 words). The manifest collects it from the place that the family already uses:

- A golden story: the `intent` string in the story's own `parameters` object. `storybook.mjs` reads it with the Storybook CSF parser, so it must be one string literal.
- An MCP eval case: the `intent` field of the case in `cases.ts`.
- A Vitest file (the latency and upgrade checks): a file next to it, `<name>.intent.md`, with only the statement.

## Prerequisites

A check lists its `prerequisites` by name. Before the checks run, the runner makes or verifies each one that the selected checks need, once, and the ones that it needs first. A check whose prerequisite fails does not run: its record has status `error` and a message with the cause and the fix. The map is [`prerequisites.mjs`](prerequisites.mjs); it is not a build system.

| Name | Makes or verifies |
| --- | --- |
| `postgres` | verifies that `DATABASE_URL` answers |
| `migrations` | verifies that the database has the migrations (fix: `pnpm db:migrate`) |
| `falkordb` | verifies that `GRAPH_DB_URI` runs a graph query |
| `bun`, `zoekt`, `ast-grep`, `docker` | verifies that the tool is installed |
| `opencode` | verifies the OpenCode version that the chat contract declares |
| `chat-sandbox-image` | builds the chat sandbox image when Docker does not have it |
| `chromium` | installs the Playwright Chromium |
| `storybook-build` | builds Storybook; with `SKIP_STORYBOOK_BUILD=1` (CI downloads the build), verifies only that it exists |
| `previous-release` | verifies `RELEASE_TREE`, a checkout of the previous release with its dependencies |
| `workbench` | verifies `MODEL_PROVIDER`, `MODEL_PROVIDER_API_KEY` and `MCP_EVAL_MODELS` (at least the gate minimum of models): the evals spend money, so they run only with the `workbench` environment |
| `codesearch-server` | verifies that `CODESEARCH_URL` answers |
| `mcp-server` | verifies that the backend of this checkout answers at `AUTH_BASE_URL` + `/mcp` |
| `aws-cdk-image-tag`, `aws-cdk-build`, `docs-mdx` | makes the generated files that a typecheck needs |

## Cost

- Time: the trace gives the time of each check of a traced run. A traced check has the time of each case. A check that ran without a trace record (a project check, a Bun lane) is in `durations`. The nightly run traces every family except the evals, the latency check and the `vercel` lane.
- Eval time and tokens: an eval record has `usage`: for each model, the input and output tokens and the cost in USD (from the OpenRouter price list; absent when the list has no price). It never holds prompt or answer text. The `MCP evals` workflow keeps the same data (`usage` of `mcp-eval-public-results.json` in the artifact `mcp-eval-results`): the time, tokens and cost of the last run of each case.

## Lanes

A lane is one Vitest run: one package directory, one config and one runtime. [`lanes.mjs`](lanes.mjs) declares each lane and its inputs.

- The CI scripts own which test files belong to a lane. `lanes.mjs` reads the inventories from `scripts/ci/test-suite.mjs --list` and `apps/codesearch/scripts/run-vitest-contracts.mjs --list`.
- `root` (the `directory` of the lane) is the package directory of the lane. The manifest states it on each check, so a reader does not infer it. A changed file below it, that is not code and that no check imports, selects the full lane.
- `inputs` are the files that change a result, but that a test does not import: configs, setup files, the lockfile, and the runner (`run.mjs` and `scripts/ci/vitest-launch.mjs`). A path that ends in `/**` stands for a whole directory. A change to an input selects the full lane.
- `config` (in `lanes.mjs` only) is the Vitest config of a lane that does not use the default one.
- `runtime` (`node` or `bun`) is the runtime of the lane. A result cache adds the version of that runtime to its key.
- `env` (optional) lists the environment variables that change the result of the lane, each as `{ name, mode }`. Mode `value` means that the value changes the result and is the same on every machine, for example `MODEL_PROVIDER`. A result cache adds a hash of the value to its key. Mode `presence` means that only set or unset matters, for example `GITHUB_TOKEN` or `AUTH_BASE_URL`. A result cache adds only `set` or `unset`. Use `presence` for a secret, and for an address that only points at a service. Never use `value` for a variable that differs for each person, checkout, or machine. Do not list a connection string or a secret that only points at a test service (`DATABASE_URL`, `AUTH_SECRET`): its value does not change a result, and a different value on each laptop prevents reuse.
- The inputs of a lane include the files that pin its tools and images: `scripts/ci/prerequisites.mjs` and the chat sandbox image for the native backend lanes, and `apps/codesearch/Dockerfile` (zoekt and the SCIP indexers) for codesearch.
- A test that spawns built code (for example the CLI tests that run `bin/ctxpipe.js`) does not import that code. Add the source of the built code as a lane input, or a change to it selects no check.
- A migration file is an input of the backend lanes, because the tests apply it to a real database.
- `traceInputs` (optional) names the inputs for which a reader with a trace may select from the trace instead of the whole lane. Without a trace, or when the trace does not hold the needed data, the input still selects the whole lane. The manifest schema gives the full rule. There are two kinds:
  - `lines`: source that the checks run only in Node child processes (the CLI source, which the CLI tests run as `bin/ctxpipe.js`). The trace records those lines, so a changed file selects the checks that ran the changed lines.
  - `tables`: the Drizzle migration directories of the backend. A changed `migration.sql` selects the checks that touched a table that a changed statement names, and the checks that read the file. `snapshot.json` is drizzle-kit state; no check reads it. A statement whose tables a reader cannot name (for example `DO $$ ... $$`) selects the whole lane.
- `run.mjs` and `scripts/ci/test-suite.mjs` start Vitest through `scripts/ci/vitest-launch.mjs`. Thus a subset run and the CI run use the same setup steps and command line.

To add a lane, add it to `lanes` in `lanes.mjs` and add its inventory to `listVitest`. To add a check family, add a new `family` value to the manifest schema, write its list and run functions, and add them to [`families.mjs`](families.mjs).

## Traces

`pnpm -s checks:run --trace <dir>` also writes `<dir>/trace.json.gz`, a gzip-compressed JSON file. The schema is [`schema/trace.v1.schema.json`](schema/trace.v1.schema.json). For each check and each test case, the trace gives the source lines that the case executed (in the test process and in its Node child processes), the semantic edges that the case used, and the case duration. The line numbers are the lines at `commit`, the commit of the checkout. Thus, trace a clean working tree.

How it works:

- The runner adds [`trace-reporter.mjs`](trace-reporter.mjs) as a Vitest reporter. Vitest has no command-line option for setup files, so the reporter puts [`trace-worker.mjs`](trace-worker.mjs) first in the setup files of each project. The runner gives the part directory to its Vitest workers in the private variable `CTXPIPE_TRACE_PARTS`. Do not set this variable yourself.
- In each Vitest worker, `trace-worker.mjs` opens a `node:inspector` session and starts V8 precise coverage with block counts. It takes the coverage before and after each test case. Each take resets the counts.
- The code that runs outside a case (module evaluation, `beforeAll` and `afterAll`) goes to the pseudo-case `<collect>` of the file. Thus, a change to top-level code maps to `<collect>`.
- The worker maps the V8 offsets to source lines. It uses the inline source maps of the transformed modules.
- A line ran when the innermost V8 range at a mapped position has a count above zero. That means the function ranges minus their nested blocks with a zero count.
- A line with no code does not end a range.
- The trace records only repo files outside `node_modules`.
- Tracing does not change a result. If the inspector fails in a file, that file writes no trace record. A check that is not in a trace was not traced; this is not proof that it executes no code.

Child processes:

- Before each case, the worker sets `NODE_V8_COVERAGE` to a directory of that case (`<collect>` has one too). A Node child process that inherits the variable writes its V8 coverage there when it exits. After the file, the worker maps that coverage to source lines (with the source maps that Node writes into the coverage file, or the file itself) and adds the lines to the case.
- A child gives no coverage when the test starts it with an `env` that does not copy `process.env`, when a signal stops it, or when it is not Node. The check's `recorded` holds `children` only when at least one child of the check wrote a coverage file. A check without `children` can still have started a child that gave no coverage, so a reader must treat its child lines as unknown. A check with `children` can also have a second child that gave none; the trace cannot show that.
- Bun children give no coverage. These tests start Bun children: `apps/backend/src/domain/workspaces/sandbox-lock-native.contract.test.ts`, `apps/backend/src/domain/workspaces/write-worker-loss-native.contract.test.ts` and `apps/backend/src/openworkflow/workflows/repository-ingestion-v2.integration.test.ts`. The sandbox tests also run processes in Docker containers, which give no coverage.

Semantic edges ([`trace-edges.mjs`](trace-edges.mjs)): the worker installs hooks once in each Vitest worker. Each hook records names only, never statement text, request data, prompt text or arguments. A hook that fails while it records turns that edge off for the call. It never changes the call or its result.

| Case property | Source |
| --- | --- |
| `tables` | The node-postgres `Client.prototype.query`: the tables after `from` and `join` (`read`), and after `insert into`, `update` and `delete from` (`write`). The hook removes string literals (`'...'`, `E'...'`, `$tag$...$tag$`) and comments first, and takes names only from these table positions, so literal text cannot become a table name. Schema statements and `truncate` are not recorded. |
| `routes` | Hono routers: each route handler that runs records `<METHOD> <pattern>`. Middleware is not recorded. |
| `steps` | OpenWorkflow: the name of each step that a run resolves, up to the first `:` (a name can hold run data after it). |
| `tools` | The MCP SDK: the name of each tool call. |
| `reads`, `dirs` | `fs`: each repo file that the case reads (`reads`), and each repo directory that it lists (`dirs`). The hook adds both kinds to `recorded`. |

- A reader decides for each check whether it may trust an empty `reads` and `dirs`: only when the check's `recorded` holds both kinds.
- A hook that cannot install (the lane does not use the package, or the package changed) records nothing. The check's `recorded` then does not hold that kind, and a reader treats the kind as unknown.
- The hooks see only the test process. Postgres queries through `postgres.js` (the OpenWorkflow backend) and the operations of a separate process (a child, a container, a server) are not recorded.

Storybook stories (the browser):

- The runner starts Playwright JS coverage (`page.coverage`, V8 block coverage) for the page of each story, and stops it after the play. The story is one case, named by its export name.
- The Storybook build writes a hidden source map next to each chunk (`build.sourcemap: "hidden"` in `apps/ui/.storybook/main.ts`). [`storybook.mjs`](storybook.mjs) maps the coverage of each chunk under `/assets/` to source lines with it, by the same rules as the Vitest worker ([`trace-lines.mjs`](trace-lines.mjs)). The prebuilt Storybook runtime holds no repo code.
- `recorded` holds `browser` only when every built chunk that ran had a source map. A chunk without a map is a gap: the check's lines are then incomplete. The runner names the number of such chunks on stderr.
- `mocks`: the preview (`apps/ui/.storybook/preview.tsx`) gives the runner the headers of the MSW handlers that answered a request of the story (`<METHOD> <path>`). A mocked route is not a backend route: a backend change cannot change the result of the story through it.
- The lines include the module code of every chunk that the story loads, and the preview and decorators. The page runs no Node code, so a story has no `tables`, `routes`, `steps`, `tools`, `reads` or `dirs`.

In CI, `scripts/ci/test-suite.mjs <lane> --trace` and `scripts/ci/storybook-golden.mjs --trace` write `trace.json.gz` next to `results.json`.

- CI passes `--trace` on a `workflow_dispatch` run and on the nightly `schedule` run (02:23 UTC, on `main`).
- The `codesearch` lane runs in its Docker test image. `apps/codesearch/scripts/run-vitest-docker.sh --trace <dir>` mounts `<dir>` at `/trace` and gives the commit as an argument, because the image has no `.git` directory. The image holds a copy of `scripts/checks`.
- The `vercel` lane needs the `workbench` environment (a Vercel token and spend). The nightly run does not start it, so only a `workflow_dispatch` run traces it.
- The nightly run starts only the test jobs, the codesearch job, the Storybook build and all-plays jobs, the upgrade job, the Project check times job, the Tests job and the Trace job. No other job runs on it, so it cannot deploy or publish.
- The Storybook all-plays shards trace every story with a play function (the golden job does not trace, so no story is traced twice). The upgrade job runs its check through `checks:run`. The Project check times job runs every `typecheck`, `lint` and `policy` check through `checks:run --trace`, only for their `durations`; the lint and typecheck jobs still gate the change.
- The Trace job merges the traces with `node scripts/checks/trace.mjs merge <out> <trace>...`. It uploads the artifact `trace-<commit>`. It is not a required check: the trace is data only.
- A pull request run and a push to `main` do not trace. A pull request tests a merge commit that a reader cannot diff from.

Gaps (no trace):

- Bun lanes (`codesearch-bun`): Bun has no V8 inspector. Bun child processes (see Child processes).
- The `vercel` lane in the nightly run (see above).
- A Node child that a test starts with its own `env`, or that a signal stops.
- Docker containers, sandboxes and separate servers. A test that reaches code through one of these does not record that code or its edges.
- The evals and the latency check (no CI run traces them; the eval times come from the eval workflow).
- Concurrent cases in one file (`test.concurrent`) mix their coverage and edges.

Overhead in CI was measured with the child-process coverage and the semantic edges (CTX-776 slice 2b). It compares a traced `workflow_dispatch` run with the untraced pull request run of the same code.

- All test jobs together took 5179 s against 4819 s (+7%). The traced run of the line coverage only (slice 2a) took 5186 s, so the child coverage and the edges add no time that the run-to-run noise shows. A second traced run took 5476 s.
- The backend shard test steps took 2438 s against 2142 s (+14%). The contract shards took 1487 s against 1454 s (+2%).
- The longest job took 918 s against 831 s (+10%).
- A child process that writes coverage is slower: the CLI test `argv.test.ts` took 2.1 s against 1.4 s.
- A take costs about 10 to 40 ms in a file that imports a large module graph. Thus the cost grows with the number of cases in such a file.
- The trace of the full run is 1.95 MB compressed (18.4 MB of JSON) for 780 checks and 7445 cases.

## Why the runner is separate from CI

CI runs `scripts/ci/test-suite.mjs`. That script requires that the executed files are equal to the full inventory, and it applies the failure baseline. A subset run cannot satisfy those rules. `run.mjs` exits with an error when it gets no check id. Thus `run.mjs` is a second path, and the CI path does not change.

## Versions

A reader must reject an unknown `schemaVersion`. A new optional property does not change the version. A change that removes or renames a property, or that changes the meaning of a property, increments the version.
