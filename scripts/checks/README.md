# Check manifest and runner

These two commands are the public check contract. A tool that selects checks (for example the factory `factory check` command) uses only these commands. It does not make a Vitest or pnpm command line itself.

## Commands

- `pnpm -s checks:list` prints the manifest as one JSON object: `{ schemaVersion, checks }`. The schema is [`schema/manifest.v1.schema.json`](schema/manifest.v1.schema.json).
- `pnpm -s checks:run [--trace <dir>] [ids-file]` runs the given check ids. Without `ids-file`, it reads the ids from stdin, one id on each line. It writes one JSON line for each id to stdout. Each line has `schemaVersion`. The schema is [`schema/result.v1.schema.json`](schema/result.v1.schema.json). The Vitest output goes to `.ci-results/checks/<lane>.log`. The exit code is 1 when a check fails or does not run.

## Check ids

A check id is `<family>:<lane>:<file>`, for example `vitest:ui:apps/ui/src/components/ui/Button.test.tsx`. The file is relative to the repo root. A later version adds case ids as `<file>#<case>`. Thus a file id is always a prefix of the ids of its cases.

## Lanes

A lane is one Vitest run: one package directory, one config and one runtime. [`lanes.mjs`](lanes.mjs) declares each lane and its inputs.

- The CI scripts own which test files belong to a lane. `lanes.mjs` reads the inventories from `scripts/ci/test-suite.mjs --list` and `apps/codesearch/scripts/run-vitest-contracts.mjs --list`.
- `root` (the `directory` of the lane) is the package directory of the lane. The manifest states it on each check, so a reader does not infer it. A changed file below it, that is not code and that no check imports, selects the full lane.
- `inputs` are the files that change a result, but that a test does not import: configs, setup files and the lockfile. A path that ends in `/**` stands for a whole directory. A change to an input selects the full lane.
- A test that spawns built code (for example the CLI tests that run `bin/ctxpipe.js`) does not import that code. Add the source of the built code as a lane input, or a change to it selects no check.
- A migration file is an input of the backend lanes, because the tests apply it to a real database.
- `traceInputs` (optional) names the inputs for which a reader with a trace may select from the trace instead of the whole lane. Without a trace, or when the trace does not hold the needed data, the input still selects the whole lane. The manifest schema gives the full rule. There are two kinds:
  - `lines`: source that the checks run only in Node child processes (the CLI source, which the CLI tests run as `bin/ctxpipe.js`). The trace records those lines, so a changed file selects the checks that ran the changed lines.
  - `tables`: the Drizzle migration directories of the backend. A changed `migration.sql` selects the checks that touched a table that a changed statement names, and the checks that read the file. `snapshot.json` is drizzle-kit state; no check reads it. A statement whose tables a reader cannot name (for example `DO $$ ... $$`) selects the whole lane.
- `run.mjs` and `scripts/ci/test-suite.mjs` start Vitest through `scripts/ci/vitest-launch.mjs`. Thus a subset run and the CI run use the same setup steps and command line.

To add a lane, add it to `lanes` in `lanes.mjs` and add its inventory to `listChecks`. To add a check family, add a new `family` value to the manifest schema, and make `listChecks` and `run.mjs` handle it.

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
- A child gives no coverage when the test starts it with an `env` that does not copy `process.env`, when a signal stops it, or when it is not Node. The check's `recorded` holds `children` all the same, so this gap is not visible in the trace.
- Bun children give no coverage. These tests start Bun children: `apps/backend/src/domain/workspaces/sandbox-lock-native.contract.test.ts`, `apps/backend/src/domain/workspaces/write-worker-loss-native.contract.test.ts` and `apps/backend/src/openworkflow/workflows/repository-ingestion-v2.integration.test.ts`. The sandbox tests also run processes in Docker containers, which give no coverage.

Semantic edges ([`trace-edges.mjs`](trace-edges.mjs)): the worker installs hooks once in each Vitest worker. Each hook records names only, never statement text, request data, prompt text or arguments.

| Case property | Source |
| --- | --- |
| `tables` | The node-postgres `Client.prototype.query`: the tables after `from` and `join` (`read`), and after `insert into`, `update` and `delete from` (`write`). Schema statements and `truncate` are not recorded. |
| `routes` | Hono routers: each route handler that runs records `<METHOD> <pattern>`. Middleware is not recorded. |
| `steps` | OpenWorkflow: the name of each step that a run resolves. |
| `tools` | The MCP SDK: the name of each tool call. |
| `models` | Langfuse: the name of each generation (a model call through `withLangfuseGeneration`). |
| `files` | `fs`: each repo file that the case reads, and each directory that it lists (with a trailing `/`). |

- A hook that cannot install (the lane does not use the package, or the package changed) records nothing. The check's `recorded` then does not hold that kind, and a reader treats the kind as unknown.
- The hooks see only the test process. Postgres queries through `postgres.js` (the OpenWorkflow backend) and the operations of a separate process (a child, a container, a server) are not recorded.

In CI, `scripts/ci/test-suite.mjs <lane> --trace` writes `trace.json.gz` next to `results.json`.

- CI passes `--trace` on a `workflow_dispatch` run and on the nightly `schedule` run (02:23 UTC, on `main`).
- The `codesearch` lane runs in its Docker test image. `apps/codesearch/scripts/run-vitest-docker.sh --trace <dir>` mounts `<dir>` at `/trace` and gives the commit as an argument, because the image has no `.git` directory. The image holds a copy of `scripts/checks`.
- The `vercel` lane needs the `workbench` environment (a Vercel token and spend). The nightly run does not start it, so only a `workflow_dispatch` run traces it.
- The nightly run starts only the test jobs, the codesearch job, the Tests job and the Trace job. No other job runs on it, so it cannot deploy or publish.
- The Trace job merges the traces with `node scripts/checks/trace.mjs merge <out> <trace>...`. It uploads the artifact `trace-<commit>`. It is not a required check: the trace is data only.
- A pull request run and a push to `main` do not trace. A pull request tests a merge commit that a reader cannot diff from.

Gaps (no trace):

- Bun lanes (`codesearch-bun`): Bun has no V8 inspector. Bun child processes (see Child processes).
- The `vercel` lane in the nightly run (see above).
- A Node child that a test starts with its own `env`, or that a signal stops.
- Docker containers, sandboxes, separate servers and the browser (Storybook). A test that reaches code through one of these does not record that code or its edges.
- Concurrent cases in one file (`test.concurrent`) mix their coverage and edges.

Overhead in CI was measured on one commit. It compares a traced `workflow_dispatch` run with the untraced pull request run.

- The backend shard test steps took 2391 s against 2172 s (+10%).
- The contract shards took 1452 s against 1426 s (+2%).
- All test jobs together took 4723 s against 4470 s (+6%).
- The longest job took 919 s against 874 s (+5%).
- A take costs about 10 to 40 ms in a file that imports a large module graph. Thus the cost grows with the number of cases in such a file.
- The trace of the full run is 1.8 MB compressed (17 MB of JSON) for 734 checks and 7079 cases.

## Why the runner is separate from CI

CI runs `scripts/ci/test-suite.mjs`. That script requires that the executed files are equal to the full inventory, and it applies the failure baseline. A subset run cannot satisfy those rules. Thus `run.mjs` is a second path, and the CI path does not change.

## Versions

A reader must reject an unknown `schemaVersion`. A new optional property does not change the version. A change that removes or renames a property, or that changes the meaning of a property, increments the version.
