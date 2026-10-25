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
- `run.mjs` and `scripts/ci/test-suite.mjs` start Vitest through `scripts/ci/vitest-launch.mjs`. Thus a subset run and the CI run use the same setup steps and command line.

To add a lane, add it to `lanes` in `lanes.mjs` and add its inventory to `listChecks`. To add a check family, add a new `family` value to the manifest schema, and make `listChecks` and `run.mjs` handle it.

## Traces

`pnpm -s checks:run --trace <dir>` also writes `<dir>/trace.json.gz`, a gzip-compressed JSON file. The schema is [`schema/trace.v1.schema.json`](schema/trace.v1.schema.json). For each check and each test case, the trace gives the source lines that the case executed and the case duration. The line numbers are the lines at `commit`, the commit of the checkout. Thus, trace a clean working tree.

How it works:

- The runner adds [`trace-reporter.mjs`](trace-reporter.mjs) as a Vitest reporter. Vitest has no command-line option for setup files, so the reporter puts [`trace-worker.mjs`](trace-worker.mjs) first in the setup files of each project. The runner gives the part directory to its Vitest workers in the private variable `CTXPIPE_TRACE_PARTS`. Do not set this variable yourself.
- In each Vitest worker, `trace-worker.mjs` opens a `node:inspector` session and starts V8 precise coverage with block counts. It takes the coverage before and after each test case. Each take resets the counts.
- The code that runs outside a case (module evaluation, `beforeAll` and `afterAll`) goes to the pseudo-case `<collect>` of the file. Thus, a change to top-level code maps to `<collect>`.
- The worker maps the V8 offsets to source lines. It uses the inline source maps of the transformed modules.
- A line ran when the innermost V8 range at a mapped position has a count above zero. That means the function ranges minus their nested blocks with a zero count.
- A line with no code does not end a range.
- The trace records only repo files outside `node_modules`.
- Tracing does not change a result. If the inspector fails in a file, that file writes no trace record. A check that is not in a trace was not traced; this is not proof that it executes no code.

In CI, `scripts/ci/test-suite.mjs <lane> --trace` writes `trace.json.gz` next to `results.json`.

- CI passes `--trace` on a `workflow_dispatch` run and on the nightly `schedule` run (02:23 UTC, on `main`).
- The nightly run starts only the test jobs and the Tests job. No other job runs on it, so it cannot deploy or publish.
- The Tests job merges the traces with `node scripts/checks/trace.mjs merge <out> <trace>...`. It uploads the artifact `trace-<commit>`.
- A pull request run and a push to `main` do not trace. A pull request tests a merge commit that a reader cannot diff from.

Gaps (no trace):

- Bun lanes (`codesearch-bun`): Bun has no V8 inspector.
- The `codesearch` lane in CI, because it runs in Docker. `checks:run --trace` traces it on the host.
- The `vercel` lane, because it runs in its own job with deploy credentials.
- Child processes and the browser. A test that reaches code through HTTP, a worker process, a CLI, a sandbox or Storybook does not record that code. For example, the CLI lane runs the built `bin/ctxpipe.js` in a child process.
- Concurrent cases in one file (`test.concurrent`) mix their coverage.

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
