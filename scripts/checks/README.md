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
| `policy` | the name of each policy script of the CI lint job, and `claude-plugin` | script | `policy:test-policy:scripts/ci/check-test-policy.mjs` | that script |
| `build` | `image-<name>` for each production image, `package-<name>` for each package build | image or package | `build:image-ui:apps/ui/Dockerfile`, `build:package-cli:packages/cli/package.json` | `docker buildx build` of the Dockerfile, or `pnpm --filter <package> build` |
| `deploy` | `preview`, `preview-ui-smoke` | preview deployment, or check against the deployed preview | `deploy:preview:.github/workflows/pr-deploy.yaml` | `pr-deploy.yaml` on the PR branch, or `scripts/ci/smoke-preview-ui.sh` against the preview |

- A Storybook story is a case of its stories file. The story id is the Storybook id, so the id stays the same when the story moves in its file. [`storybook.mjs`](storybook.mjs) lists the stories with the Storybook indexer (`buildIndex`), and runs them against `apps/ui/storybook-static`.
- An eval case calls paid models. The record has `stochastic: true`: the same inputs can give a different result, so a result cache must not reuse it. Its inputs are only its harness. `tools` lists the MCP tools that the case declares. A reader selects the case by those tools and the trace's `tools` edges (the tools that each Vitest case called), then by its `intent`. A reader never selects it by an import. The verdict of a case is the eval gate (`apps/backend/evals/mcp/gate.ts`) for that one case: its thresholds and the baseline drop for the case. When a model has no baseline entry for the case, only the pass-rate floor applies, and the case message says "no baseline". A whole-run gate failure (for example, too few models) does not change the verdict of a case. The runner writes it to stderr as one note. The memory live evals have no check; each scenario is listed when a live runner can run it.
- The `latency` and `upgrade` lanes run the files that the PR suite does not run (`*.latency.ts`, `*.upgrade.ts`), each with its own Vitest config. A latency result is `stochastic`: wall-clock bounds vary on shared runners.
- The `typecheck`, `lint` and `policy` checks run a fixed command over a whole project, so they have no trace. Their `inputs` approximate the files that they read with whole directories (for example `apps/**` for oxlint, `apps/backend/src/**` for the UI typecheck, because the UI types import the backend RPC types, and the repo-root `shared/**` for the backend, codesearch and UI typechecks). A change in one of them selects the check. Their `root` is the repo root (`""`) or the project directory.
- A `typecheck` check is incremental. It keeps the TypeScript build info in `node_modules/.cache/typecheck/`. It checks again only the files that a change can affect. When the result does not match the diagnostic allowance, it deletes the build info and checks all files again. Thus, a failure always comes from a full check. Delete that directory to force a full check. The CI Typecheck job keeps the directory in the cache. The job on a push to `main` does not restore the cache, so it is always a full check.

## Builds

The `build` checks are the jobs Production build and Runnable packages of `ci.yaml`. The Packages job runs its checks with `pnpm -s checks:run` and keeps the records in the `test-results-build-packages` artifact. Each Production build matrix job is a plain Docker build with no workspace install: the merge gate takes the result of the job `Production build (<name>)` as the result of the check `build:image-<name>:` (`stepResults` in `gate.mjs`). `pnpm checks:run` runs the same build on a laptop. In gate mode (see Merge gate) a build runs on a pull request only when the plan selects its check. A person asks for every build with **Run workflow** (`workflow_dispatch`) of CI on the PR branch: that run is full. On a merge to `main`, the deploy workflows build the release images. The nightly run builds every image and package, as the safety net of the gate. Release and deploy images come only from the deploy workflows, with no selector and no cache.

| Job | Matrix entry or step | Check |
| --- | --- | --- |
| `production-builds` | `backend` | `build:image-backend:apps/backend/Dockerfile` |
| `production-builds` | `worker` | `build:image-worker:apps/backend/Dockerfile.worker` |
| `production-builds` | `ui` | `build:image-ui:apps/ui/Dockerfile` |
| `production-builds` | `codesearch` | `build:image-codesearch:apps/codesearch/Dockerfile` |
| `production-builds` | `docs` | `build:image-docs:apps/docs/Dockerfile` |
| `production-builds` | `chat-sandbox` (arm64) | `build:image-chat-sandbox:scripts/chat-sandbox/Dockerfile` |
| `packages` | `@ctxpipe/backend` | `build:package-backend:apps/backend/package.json` |
| `packages` | `@ctxpipe/codesearch` | `build:package-codesearch:apps/codesearch/package.json` |
| `packages` | `@ctxpipe/aws-cdk` | `build:package-aws-cdk:packages/aws-cdk/package.json` |
| `packages` | `ctxpipe` | `build:package-cli:packages/cli/package.json` |
| `packages` | `@ctxpipe/aws-cdk-self-host` typecheck | `typecheck:self-host:examples/aws-cdk-self-host/tsconfig.json` (also in the Typecheck job) |
| `layer-cache` | all | none |

- The inputs of an image are its Dockerfile, the root files that it copies (the lockfile, `patches/**`, `.dockerignore`) and the directories that it copies. The inputs of a package are its directory, the lockfile and the directories that it imports.
- An image build has `cacheable: false`: it pulls base images by tag, and packages from the network without a lock, so the same inputs can give another result. A result cache never reuses it, but a selector selects it by its inputs (unlike a `stochastic` check). A package build reads only the checkout, so the cache keys it as any other check. The backend and codesearch builds have the `bun` runtime, so a key holds the Bun version. The aws-cdk build sets `IMAGE_TAG=check`, so the stamped image tag does not depend on the commit.
- An image check needs the `docker` prerequisite. The codesearch image builds for `linux/amd64` (its Dockerfile stops on another architecture), and reads the public layer cache `ghcr.io/ctxpipe-ai/ci-cache:production-codesearch` without a login. The chat-sandbox image builds for `linux/arm64`: on an amd64 machine, install binfmt/QEMU first (the CI job does this).
- The Layer cache job is cache warming, not a check. It writes the layer caches on `main` only, and its failure is a miss on the next run. A cache miss makes a build slower, never another result.
- Cost: the record of each build has its `durationMs`. The shadow estimate counts both jobs as always-run jobs (`cost` in `gate.mjs`), so a build check has no shard profile. In gate mode the plan job gives the matrix entries of the selected images (`jobOutputs` in `plan.mjs`), and a test keeps them equal to the full matrix of `ci.yaml`.

## Preview deployment

The `deploy` checks are the PR preview of `pr-deploy.yaml` (Railway and Neon) and the one automated check that runs against the deployed preview.

| Check | Job and step of `pr-deploy.yaml` | Catches |
| --- | --- | --- |
| `deploy:preview:.github/workflows/pr-deploy.yaml` | `Deploy PR environment (Railway + Neon)`, step `Update Railway service config via GraphQL and deploy once` | a deployment that does not start or wire up |
| `deploy:preview-ui-smoke:scripts/ci/smoke-preview-ui.sh` | the same job, step `Smoke-test the preview UI` | a preview backend that does not serve the UI of its own build |

- The inputs of the deployment are its config: `pr-deploy.yaml`, each script that it sources, the Dockerfiles of the four preview images and their start commands, the backend variables (`apps/backend/src/config/env.ts`), the migrations, the config of the connector asset test that the deploy needs, and the Railway and Neon Terraform files of the production environment that each preview copies. No input is a lockfile or a package manifest: a dependency change selects the `build:image-*` checks, which build the images, and a full preview deploy for each dependency bump costs too much. A change to app code that a unit or contract check covers is not an input. A selector follows the imports of a source input, so no input is an app entry file (such as `server.ts`): it would select the deployment on each app change. A test keeps each source input free of repo imports. The inputs of the smoke test are the smoke script, the private UI setup and the UI Dockerfile.
- Both checks have `cacheable: false`: the result comes from Railway and Neon, so a result cache never reuses it. A selector selects them by their inputs.
- No other check runs against the deployed preview in PR CI. The jobs before the deploy (the PR images, the connector asset check, the Neon branch and the migrate) are part of the deployment: when one fails, the deploy job does not run, and the gate maps `deploy:preview` to `failed`. The `preview-env` agent skill and the `PR preview roll existing images` workflow are run by hand and are not checks.
- Result in the merge gate: the shadow job reads the jobs of the newest PR Deploy run of the PR head (`--deploy` of `gate.mjs`), and `stepResults` maps each step to its check (`deploySteps`). The PR Deploy run often ends after CI. The shadow job takes the newest run whose deploy job did not skip. A run that has not ended gives `pending` for both checks, and `pending` stays out of the agreement metrics.
- Prerequisite: `preview-pr` (`PR_NUMBER` is set, the GitHub CLI is logged in, and the PR head is the local `HEAD`), for both checks. The smoke script retries until the preview answers. The manual run waits for a new run of the current commit. The secrets are in the GitHub environment `Preview`, never on a laptop. Thus `pnpm checks:run` of `deploy:preview` starts PR Deploy on the PR branch with `gh workflow run` and waits for it with `gh run watch`.
- When PR Deploy runs: in shadow mode, on each push to a same-repository pull request (`opened`, `reopened`, `synchronize`), not on a fork. In gate mode a push does not deploy: the job `resolve_pr` reads `merge-gate.json` of the PR head and stops. The job Merge gate starts PR Deploy (`merge-gate-deploy`) when the plan selects a deploy check, or when the run of a same-repository PR is full. A person can ask for a new deploy with **Run workflow** (`workflow_dispatch`) from the PR branch, with the PR number as input. A run from `main` fails. `pr-preview-roll-existing.yaml` rolls the images that exist without a build. No label or comment starts a deploy.

## Other pull request workflows

Some checks also run in a workflow other than `ci.yaml`. These workflows keep their own triggers. In gate mode the merge gate lists a selected check of such a workflow as `in other workflows`: the status of that workflow is its result, and it is not part of the gated verdict. Each job maps to a check as follows:

| Workflow | Job | Check |
| --- | --- | --- |
| `cli-test.yaml` | `ctxpipe-cli` | the `vitest:cli` lane |
| `claude-plugin-test.yaml` | `backend` | its files in the `vitest:backend` lane |
| `claude-plugin-test.yaml` | `ui` | the `vitest:ui` lane |
| `mcp-evals.yaml` | `evals` | the `eval:mcp` cases |
| `terraform-plan-pr.yaml` | `terraform-plan` | `policy:terraform-plan:infra/main.tf` |
| `ingestion-v2-proof.yaml` | `proof` | none |
| `mcp-evals-reminder.yaml` | `remind` | none |

- The `claude-plugin` check runs as a step of the Lint and format job of `ci.yaml`. It needs the network: `npx` downloads the pinned Claude Code. `claude-plugin-test.yaml` has no job for it.
- The Terraform plan has `cacheable: false`: its result comes from the remote Terraform state, so a result cache never reuses it. Its inputs are `infra/**`, so a selector selects it when a Terraform file changes. It has the `terraform-plan` prerequisite: the Terraform CLI and the state keys (`R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`) of the `terraform-plan` environment. The check does not write the PR comment; the workflow does. The `ci.yaml` Terraform job, which runs on each pull request, validates the code.
- The ingestion proof has no check. It needs a Compose `deploy` stack, a Workspace repository and the repository list from the workbench secrets, and the script `scripts/ci/ingestion-v2-proof.sh` reads them from the workflow. Listing it needs a runner that starts that stack, which is more than a command. Only the CTO starts it by hand, and it spends model money on real repositories.
- The reminder has no check. It only writes a PR comment.

## Intent

An expensive check states what it catches, and what is never a reason to run it, in `intent` (under about 40 words). The manifest collects it from the place that the family already uses:

- A golden story: the `intent` string in the story's own `parameters` object. `storybook.mjs` reads it with the Storybook CSF parser, so it must be one string literal.
- An MCP eval case: the `intent` field of the case in `cases.ts`.
- A Vitest file (the latency and upgrade checks): a file next to it, `<name>.intent.md`, with only the statement.

## Prerequisites

A check lists its `prerequisites` by name. Before the checks run, the runner makes or verifies each one that the selected checks need, once, and the ones that it needs first. A check whose prerequisite fails does not run: its record has status `error`, `origin: "prerequisite"` and a message with the cause and the fix. The runner also sets `origin: "runner"` on an `error` record when the runner failed or the check id is unknown. Only the runner sets `origin`; a test file that throws at load gives an `error` record without it. A reader detects an infrastructure fault from `origin`, never from the message text. The map is [`prerequisites.mjs`](prerequisites.mjs); it is not a build system.

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
| `terraform-plan` | verifies the Terraform CLI and the state keys of the `terraform-plan` environment |
| `codesearch-server` | verifies that `CODESEARCH_URL` answers |
| `mcp-server` | verifies that the backend of this checkout answers at `AUTH_BASE_URL` + `/mcp` |
| `preview-pr` | verifies `PR_NUMBER`, the GitHub CLI login, and that the PR head is the local `HEAD` |
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

`pnpm -s checks:run --trace <dir>` also writes `<dir>/trace.json.gz`, a gzip-compressed JSON file. The schema is [`schema/trace.v1.schema.json`](schema/trace.v1.schema.json). For each check and each test case, the trace gives the source lines that the case executed (in the test process and in its Node and Bun child processes), the semantic edges that the case used, and the case duration. The line numbers are the lines at `commit`, the commit of the checkout. Thus, trace a clean working tree.

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

- Before each case, the worker sets `NODE_V8_COVERAGE` to a directory of that case (`<collect>` has one too). A Node child process writes its V8 coverage there when it exits. Node adds the variable to the `env` of each child, also when the test gives its own `env`. After the file, the worker maps that coverage to source lines (with the source maps that Node writes into the coverage file, or the file itself) and adds the lines to the case.
- The worker also adds the preload [`trace-bun.mjs`](trace-bun.mjs) to `BUN_OPTIONS`. Bun runs JavaScriptCore, so a Bun child gives no V8 coverage, and the offsets that Bun can give are offsets in its own transpiled code, which has no source map. Thus the preload records the repo files that the Bun child loads, in the same directory. It writes each path at once, so the list stays when a signal stops the child. After the file, each line with code of each listed file goes to the case. For a Bun child, the case lines are whole files: they show that the case can run each line, not that it ran it.
- `--preload` in `BUN_OPTIONS` reaches every Bun descendant. Thus `bun install`, `bun x`, or a repo path with a space fail under tracing. No traced test does this today. Loading the workspace-semantic-merge graph took 0.8 s with the preload and 1.1 s without.
- A child gives no data when a Node child still runs when its test file ends, when a signal stops a Node child (Node writes its coverage only when it exits), when a Bun child gets an `env` without `BUN_OPTIONS`, or when it is not Node or Bun. The sandbox tests also run processes in Docker containers, which give no data.
- The worker watches the Node and Bun children that the test starts with `spawn`, `execFile` or `fork`. The check's `recorded` holds `children` only when at least one child of the check wrote data and no watched child lost it. A child that the test starts through a shell or a script, or with a sync function (`spawnSync`), is not watched. Thus a reader must treat the child lines of a check without `children` as unknown, and a check with `children` can still have an unwatched child that gave no data.
- The fixtures in [`scripts/tests/fixtures/trace-children`](../tests/fixtures/trace-children) test a Node child, a Bun child that a signal stops, and a Node child that a signal stops.

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
- The nightly run starts only the test jobs, the codesearch job, the Storybook build and all-plays jobs, the upgrade job, the Project check times job, the Tests job, the Trace job, the Merge gate manifest job and the Results writer. No other job runs on it, so it cannot deploy or publish a package. The Results writer writes only the `ci` class of the result store (see Merge gate).
- The Storybook all-plays shards trace every story with a play function (the golden job does not trace, so no story is traced twice). The upgrade job runs its check through `checks:run`. The Project check times job runs every `typecheck`, `lint` and `policy` check through `checks:run --trace`, only for their `durations`; the lint and typecheck jobs still gate the change.
- The Trace job merges the traces with `node scripts/checks/trace.mjs merge <out> <trace>...`. It uploads the artifact `trace-<commit>`. It is not a required check: the trace is data only.
- A pull request run and a push to `main` do not trace. A pull request tests a merge commit that a reader cannot diff from.

Gaps (no trace):

- Bun lanes (`codesearch-bun`): Bun has no V8 inspector. A Bun child process gives whole files, not lines (see Child processes).
- The `vercel` lane in the nightly run (see above).
- A Node child that a signal stops gives no data.
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

## Result records in CI

`scripts/ci/test-suite.mjs` and `scripts/ci/storybook-golden.mjs` also write `records.ndjson` next to `results.json`: one result record (schema `result.v1`) for each test file or story that the job ran. `apps/codesearch/scripts/run-vitest-contracts.mjs --records <dir>` does the same for both codesearch runtimes. The Typecheck, upgrade and Project check times jobs keep the `checks:run` output in the same way. Each job that runs checks uploads its records in a `test-results-*` artifact (the Lint and format job excepted: each of its steps is one check). These records are data only: an error that writes no records does not change a result. The merge gate and the Results writer read them. In the nightly run (and a run by hand), a test job with a failed check runs each failed check once more through `checks:run`, with [`rerun-failed.mjs`](rerun-failed.mjs) (at most 50 checks; it lists the others in `rerun/not-rerun.txt`, and the Results writer shows that list). It writes those records to `rerun/rerun.ndjson` and the rerun logs to `rerun/checks/` in the same artifact. The logs of the first run stay in `checks/`. The codesearch job has no rerun, so its failures are never confirmed.

## Merge gate

The merge gate decides which checks a pull request must pass ([CTX-774](https://linear.app/ctxpipe/issue/CTX-774), [CTX-1054](https://linear.app/ctxpipe/issue/CTX-1054)). [`.github/merge-gate.json`](../../.github/merge-gate.json) holds the mode, the pinned selector release (the `factory` version and the SHA-256 of `factory-linux-x64.tar.gz`), `acceptAgentResults` and `acceptPrResults`. There are two modes:

- **`gate`**: a same-repo pull request runs only the selected checks and their prerequisites. The job **Merge gate** is the verdict: it fails when the gated run fails. A full decision (see When the run is full), a fork PR, a push, the nightly run and a run by hand run every job, and then Merge gate fails when a job of that full run fails.
- **`shadow`**: the full run gates each pull request, and the job **Merge gate (shadow)** publishes beside it what a gated run would decide. Set `mode` back to `shadow` to stop the gate.

The jobs in `.github/workflows/ci.yaml`:

- **Merge gate manifest** holds no credential. `gate.mjs mode` decides with the public rules below whether the selector runs. Then the job writes the manifest (`checks:list`) and the toolchain record ([`toolchain.mjs`](toolchain.mjs), schema [`toolchain.v1`](schema/toolchain.v1.schema.json)). It has the setup of the test jobs and sets none of the lane variables, so the toolchain record is theirs.
- **Merge gate selection** runs only for a same-repo pull request. It gets a read-only role of the factory account through GitHub OIDC (a pull request from a fork gets no OIDC token). It downloads the pinned selector and stops when the SHA-256 differs. It runs `factory check --include-stochastic --cache-only --json` with variant B, k = 3 and no model step, on the merge revision against its first parent. It reads the manifest and the toolchain record only as data. It runs no package manager, no local action and no repository script, and each action is pinned by commit. It writes the selection record (schema [`selection.v1`](schema/selection.v1.schema.json)) without the self-reported writer of each hit, and keeps the selector release for the next job. When it fails, it writes `select-cause.txt` with the exact cause: the inputs did not download, the role was not assumed, the download failed, the hash does not match the pin, the selector exit code, or a timeout (3 minutes). It does not use the `workbench` environment: it reads only our own result store and the selector release through a read-only OIDC role, needs no secret and spends no money (`scripts/ci/check-secret-jobs.mjs`).
- **Merge gate LLM selection** runs the same release again with the LLM stage (`--llm-select --include-stochastic --llm-provider openrouter --dry-run`, Claude Haiku 5.5). It uses the `workbench` environment for the model key (`MODEL_PROVIDER_API_KEY`) and holds no cloud role. It checks the release against the pinned SHA-256 again, and runs no package manager and no repository script. It makes no cache lookup. When it fails, it writes `llm-cause.txt`, and the deterministic selection stays.
- **Merge gate plan** (`gate.mjs plan`, [`plan.mjs`](plan.mjs)) holds no credential and runs no package. It takes the selected and omitted checks of the LLM job, the cache lookup of the select job and the PR store, and writes `plan.json` (artifact `merge-gate-plan`). In gate mode its outputs give each check job its checks (see Gate mode). In shadow mode, or when the selector failed, its mode is `full` and every job runs.
- **Merge gate starts PR Deploy** runs in gate mode when the plan selects a deploy check, or when the run is full. It has only `actions: write` and runs no repository code.
- **Merge gate** (or **Merge gate (shadow)**) runs after every job. `gate.mjs decide` computes the verdict and the metrics, and publishes them in the job summary, in the artifact `merge-gate-decision` (`decision.json` and the selection record) and in one PR comment that it updates. A fork PR gets only the summary. It also writes the next PR store. In shadow mode it continues on error, so it cannot fail the run.
- **Results writer** runs after a full run on `main` (the nightly run, or a run by hand on `main`). See Result store.

**Gate mode.** The plan puts each check that runs into the job of `ci.yaml` that runs it (`placeOf` in `plan.mjs`):

| Job | In gate mode |
| --- | --- |
| Lint and format, Terraform configuration, Migrations | always run; each lint and policy check is a step of Lint and format |
| Typecheck, UI, CLI and CDK tests, Runnable packages, Hosted sandbox (Vercel) | run only the planned checks, with [`selected.mjs`](selected.mjs) |
| Test shards | the shards of the planned backend and contract checks (lane `selected`, from `shard.mjs`) |
| Storybook build and plays | the build, then the shards of every planned story (golden stories too); the golden job does not run |
| Production build | one matrix entry for each planned image |
| Codesearch, Upgrade from the previous release | the whole job, when the plan selects one of its checks |
| Tests (the union of the shards) | does not run: a gated run has no full inventory |
| PR Deploy, MCP evals, Terraform plan | their own workflows (see Other pull request workflows) |

A job without a planned check does not start. Each check job needs the plan job and starts with `!cancelled()`, so a push, the nightly run and a run by hand (no plan job) run the full jobs as before. When the plan job fails, its mode is empty and the run is full. `selected.mjs` reads the plan of its job (`PLAN`: `ids`, and `rerun`), runs the ids through `run.mjs`, writes `records.ndjson`, and prints the end of the log of each check that did not pass.

**PR store (the `pr` class).** The Merge gate job writes each check of the run that passed under a key to the PR store, and the plan job of the next run of the same PR reads it. The store is `store.json` in the GitHub Actions cache (key `merge-gate-pr-<PR>-<run>-<attempt>`; the plan job restores the newest). Only a run of this PR writes that cache scope: a pass of one PR never reaches another PR. A pass is accepted when its id and key are equal to a miss of the select job, its key is not quarantined, and `acceptPrResults` is true. The trust is that of a person who can push to the PR: the runs of the PR run its code, so such a person can write a false pass. That is the trust of the `agent` class too. The full run on `main` each night is the safety net.

**Contradiction rule.** A check that runs although a pass is stored for its key (a hit that is not accepted, a check of a job-scoped `ci.yaml` change, or a quarantined key) is in `rerun`. When it fails, its job runs it once more (`rerun-failed.mjs`, `rerun.ndjson`). A second failure quarantines the key in the PR store: no run of this PR accepts a stored pass of any class for that key. A pass on the rerun is a flake: nothing is quarantined, and the first failure still fails the gated run. The `ci` class and its quarantine stay as the Results writer keeps them.

**The PR comment** in gate mode gives the verdict, the counts, the LLM stage (what the change does, its kind, the behaviors that it can break, the drops and adds with their reasons, the time and the cost), the runner minutes of the run against an estimate of a full run, and collapsed tables: the checks that ran with their reasons and results, the hits with their class, host and time, the LLM decisions, the checks of other workflows, and the omitted checks by lane and reason.

**When the run is full.** `gate.mjs mode` gives the full run, with the reason, for: an event that is not `pull_request`; a fork PR; a change to a gate input, that is, a file that can change how the gate decides: `.github/workflows/ci.yaml`, `.github/actions/**`, `.github/merge-gate.json`, the code in `scripts/checks/` (`*.mjs` and `schema/*.json`, not Markdown) and the runner scripts `scripts/ci/vitest-launch.mjs`, `test-suite.mjs`, `graph-ready.mjs`, `prerequisites.mjs`, `storybook-play.mjs`, and each `scripts/ci/*.json` data file; a file that changes how the manifest is made, because the manifest job runs the code of the PR (`pnpm install`, `pnpm -s checks:list`): `.npmrc`, `patches/`, and each file that `scripts/checks/list.mjs` runs or imports outside `scripts/checks/` (`apps/backend/evals/mcp/cases.ts` and `gate.ts`, `apps/ui/.storybook/check-modules.mjs`, `apps/codesearch/scripts/run-vitest-contracts.mjs`); no pinned release. A test walks the imports of `list.mjs` and checks that each such file forces a full run. Package files, the lockfile, other workflows and `.node-version` do not force a full run: the selector reads them as lane inputs, and the toolchain is part of each key. The shadow job also gives the full run when the manifest job or the select job did not succeed (with the cause from `select-cause.txt`), or when the selection record does not match its schema. A run by hand (`workflow_dispatch`) is always full.

**A change to `ci.yaml` in check jobs.** When `ci.yaml` is the only changed gate input, and each changed line (from `git diff -U0`, on both sides) is a blank or comment line or is in the `steps` of a job that runs a check, the selector runs. `gate.mjs mode` then writes the names of those jobs to `jobs` in `mode.json`. The shadow job selects each check that runs in one of those jobs (`runsInOf` in `shard.mjs`; the Storybook jobs for `storybook-build`) and does not accept a hit for it, because no cache key holds `ci.yaml`. The run stays full when a changed line is before `jobs:`, is in a job that runs no check (for example `test` or a merge gate job), or is in another key of a job, such as `name`, `needs`, `if`, `runs-on`, `env`, `services` or `strategy`.

**The gated verdict** (`gatedVerdict` in `gate.mjs`). Each selected check needs one accepted result:

- A hit of the `ci` class is accepted. A hit of the `agent` class is accepted when `acceptAgentResults` is true, except in the `vercel` lane: its job sets `GITHUB_TOKEN` and `VERCEL_TOKEN`, which the toolchain record does not hold, so the key does not describe that run.
- The selector does not accept a quarantined key, or an agent entry of a quarantined writer (see Result store). It says so in a cache note.
- A hit of the `pr` class (the PR store) is accepted when `acceptPrResults` is true.
- Every other selected check runs. In shadow mode its result is its record of the full run. A lint or policy check takes the result of its step in the Lint and format job, which runs one check in each step. A check without a record is a `missing result`, with the result of its job: the check did not run, or its job lost the record.
- The gated run fails when a check that runs failed, had an error or has a missing result, or when an always-run job failed. In shadow mode the always-run jobs are the production builds, runnable packages, migrations and Terraform; in gate mode they are Lint and format, migrations and Terraform, and a build is a check that runs. Else it passes.
- An omitted check is never a hit, and a hit never runs.

**The switch to `gate` mode** came after the historical validation: on the replay of the PR runs since PR 280, with the LLM stage and the cache, the selection held 70 of 71 real failures, and an average PR run took 38.8 runner minutes against 109.6 for the full run (CTX-1054). Known gap: CI has no co-failure index (`--history`), which the replay used.

**Metrics** in `decision.json`, for each PR run:

- `selectionAgreement`: only the checks count. `agree` when a check failed in both runs or in neither, `escape` when a check failed only in the full run, `false failure` when a check that the gated run would run failed only there. A check that the gated run would run, with an `error` record or without a record, fails in both runs: the gated verdict and the recall count it the same way.
- `overallAgreement`: the same for the two verdicts, with the always-run jobs.
- Both are `cancelled` when a job of the full run was cancelled: the report counts these runs apart.
- `flakyJobs`: the jobs that failed in an earlier attempt of the run and passed in this one. A rerun of the same head passed them, so they are flakes, not failures. The report counts the last attempt of each run.
- `recall`: the checks that failed in the full run, how many of them the gated run would run, and why each other one would not run. `unverified` lists each omitted check and each hit with an `error` record or without a record in the full run: the full run did not prove it, and the gated run would not run it.
- `contradictions`: an accepted hit whose check failed in the full run of the same revision. This must not occur.
- `cost`: the runner minutes and the wall time of the full run (measured from the jobs of the run) and of the gated run (estimated: the manifest and select jobs, the always-run jobs, and the shards of [`shard.mjs`](shard.mjs) with the measured setup time of each profile job).

**Shards.** `shard.mjs` puts the checks that run into the profile jobs (project checks, Node tests, database tests, upgrade, codesearch, Vercel, Storybook). It gives each shard about 5 minutes of test time, with at most the shard count of the full run. The time of a check comes from the newest trace, then from `scripts/ci/test-weights.json`, then from a fixed guess.

**Result store.** The selector looks up passes in the `PaseoHub-CheckResults` bucket of the factory account, in two classes. The `ci` class (`results/v2/ci/<key>.json`) has only one writer: the Results writer job. It stores each pass of a full run on `main`, and audits each failed check against the passes that the store holds for its key. A stored pass for a key that failed is a contradiction: the job fails (it continues on error, so the run does not), and its output names the check and the key. It quarantines only a confirmed failure: the check failed again in its rerun (`rerun.ndjson`). A rerun that passed is a flake, and a check without a rerun record is not confirmed; both are reported and not quarantined. For a confirmed failure it writes a marker for the key (`quarantine/key/<key>.json`). It also writes one for each agent writer whose own entry for the key says passed (`quarantine/writer/<SHA-256 of the writer>.json`), but only when the key has complete inputs: a traced key whose trace recorded the file-system reads of the check. The output gives the evidence for each writer marker. When the run has an infrastructure fault (an `error` record with an `origin`) or more than 10 confirmed keys, no writer is quarantined. Each such writer gets a suspect marker (`quarantine/suspect/<SHA-256 of the writer>.json`) instead, the output prints its hash, and the step gives an error annotation, so that a person or the nightly agent reviews it. A suspect marker refuses nothing. Only the Results writer can put a marker. A reader treats a quarantined key or writer as a miss. Markers are outside `results/`, so they do not expire. An S3 error in the audit gives an error annotation, and nothing is quarantined. Without a pinned release, the Results writer stores nothing and says so in a notice. The role of the job trusts only a job on `main` without a GitHub environment. The `agent` class (`results/v2/agent/<key>/<writer>.json`) has the passes of people and agents. The bucket policy lets a writer put only at its own name, so a person with factory access can find the writer of a contradiction from the key. The public output names a writer only by its hash.

Known gaps: the toolchain record holds one environment for all lanes (see the `vercel` exception). `.node-version` pins the exact Node version of CI, so an agent sandbox with the same version gets the same key. The passes of an earlier run of the same pull request are the PR store (see above).

## Why the runner is separate from CI

CI runs `scripts/ci/test-suite.mjs`. That script requires that the executed files are equal to the full inventory, and it applies the failure baseline. A subset run cannot satisfy those rules. `run.mjs` exits with an error when it gets no check id. Thus `run.mjs` is a second path, and the CI path does not change.

## Versions

A reader must reject an unknown `schemaVersion`. A new optional property does not change the version. A change that removes or renames a property, or that changes the meaning of a property, increments the version.
