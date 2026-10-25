# Check manifest and runner

These two commands are the public check contract. A tool that selects checks (for example the factory `factory check` command) uses only these commands. It does not make a Vitest or pnpm command line itself.

## Commands

- `pnpm -s checks:list` prints the manifest as one JSON object: `{ schemaVersion, checks }`. The schema is [`schema/manifest.v1.schema.json`](schema/manifest.v1.schema.json).
- `pnpm -s checks:run [ids-file] [--output <file>]` runs the given check ids. Without `ids-file`, it reads the ids from stdin, one id on each line. It writes one JSON line for each id to stdout, or to the output file. The schema is [`schema/result.v1.schema.json`](schema/result.v1.schema.json). The Vitest output goes to `.ci-results/checks/<lane>.log`. The exit code is 1 when a check fails or does not run.

## Check ids

A check id is `<family>:<lane>:<file>`, for example `vitest:ui:apps/ui/src/components/ui/Button.test.tsx`. The file is relative to the repo root. A later version adds case ids as `<file>#<case>`. Thus a file id is always a prefix of the ids of its cases.

## Lanes

A lane is one Vitest run: one package directory, one config and one runtime. [`lanes.mjs`](lanes.mjs) declares each lane, its prerequisites and its inputs.

- The CI scripts own which test files belong to a lane. `lanes.mjs` reads the inventories from `scripts/ci/test-suite.mjs --list` and `apps/codesearch/scripts/run-vitest-contracts.mjs --list`.
- `prerequisites` are coarse names of the tools and services that the lane needs. The runner does not start or check them.
- `inputs` are the files that change a result, but that a test does not import: configs, setup files and the lockfile. A change to an input selects the full lane.

To add a lane, add it to `lanes` in `lanes.mjs` and add its inventory to `listChecks`. To add a check family, add a new `family` value to the manifest schema, and make `listChecks` and `run.mjs` handle it.

## Why the runner is separate from CI

CI runs `scripts/ci/test-suite.mjs`. That script requires that the executed files are equal to the full inventory, and it applies the failure baseline. A subset run cannot satisfy those rules. Thus `run.mjs` is a second path, and the CI path does not change.

## Versions

A reader must reject an unknown `schemaVersion`. A new optional property does not change the version. A change that removes or renames a property, or that changes the meaning of a property, increments the version.
