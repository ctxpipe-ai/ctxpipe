# PR 280 CI under 10 minutes from commit to green

Status: done
Priority: P1
Owner: claude
Blocked by: none
Created: 2026-10-07
Updated: 2026-10-07

## Context

The user approved this work on 2026-10-07. Measurements come from CI run 37532458859.

- `.github/workflows/ci.yaml` is new on this branch. The "Tests" job was the critical path at 46 minutes (2739 s) on `ubuntu-latest` (4 vCPU). All other jobs ended in less than 7 minutes in parallel: codesearch production build 419 s, Storybook golden journey 405 s, codesearch toolchain contracts 358 s, Vercel contracts 247 s, typecheck 210 s.
- Steps of the old "Tests" job: containers 42 s, setup-node 18 s, pnpm install 18 s, native revision index tools 95 s, migrate 11 s, chat sandbox image 39 s, backend tests 1158 s, deterministic contracts 1325 s, then the short UI, CLI and CDK tests.
- `apps/backend/vitest.config.ts` sets `fileParallelism: false` (since #319). Native contracts share the OpenWorkflow namespace "default". OpenWorkflow 0.10.1 workers claim every open run in their namespace, whatever its workflow name. Thus each file runs in series: backend 300 files, 820 s of test time plus about 5 minutes of module import; contracts 52 files, 1202 s.
- The slowest files: `conversation-branch-push-native` 206 s (10 Docker sandbox starts), `write-pause-native` 198 s, `write-worker-loss-native` 138 s, `connector-config-native` 105 s. Together they are 32% of the serial time.

## Plan

1. Split the backend lane and the contract lane into separate parallel jobs, each with its own Postgres and FalkorDB.
2. Shard the two lanes. Each shard has its own database, so a workflow claim cannot cross shards. Keep the report and inventory check correct across the shards.
3. Cache the setup: the zoekt tools, the chat sandbox image, and the pnpm store.
4. Cache the Docker layers of the codesearch production build.
5. If time remains, remove fixed real-time waits from the four slowest files.

## Resolution

1. Done. `ci.yaml` has a `test-shards` matrix job, a "UI, CLI and CDK tests" job, and a "Tests" job. The "Tests" job needs the other two, so the old check name stays. No workflow and no branch protection rule refers to the check name (main has no required status checks).
2. Done. `scripts/ci/test-suite.mjs` accepts `--shard=i/N` for `backend` and `contracts`. It gives each file to the least loaded shard, longest file first, with the measured seconds in `scripts/ci/test-weights.json` (one second is added to each file for its import). A stale or missing weight changes only the balance; it never drops a file. A shard checks its own report with the allowances for its own files and writes `exit-code`. The "Tests" job downloads all shard results and runs `test-suite.mjs <lane> --merge`. That step requires every shard from 1 to N, joins the reports, and runs `check-test-report.mjs` with the full inventory, the full failure baseline, and the highest shard exit code. Thus a missing file, a file that ran twice, an unexpected failure, a skipped test, or a runner failure still stops CI. `scripts/tests/ci-test-shards.test.mjs` proves that the shard union equals the old file list, once per file, and that the merge step stops on a duplicate file, a runner failure, and a missing shard. Shard loads from the weights: backend 4 shards of 189 to 206 s; contracts 5 shards of 238 to 240 s.
3. Done. `actions/cache` keeps the built zoekt binaries, keyed on the operating system, the architecture, the Go version and the zoekt commit. `setup-go` runs only on a cache miss. The chat sandbox image builds with Buildx and the GHA cache (scope `chat-sandbox`); only backend shard 1 writes the cache. `setup-node` already caches the pnpm store.
4. Done. The production build matrix uses Buildx. Only codesearch reads and writes a GHA layer cache (`mode=max`), because the repository cache (10 GB) cannot hold all five images.
5. Skipped. The long waits are bounded polls on real lease expiry. That expiry comes from OpenWorkflow internals and from module constants (for example `LEASE_MS` in `sandbox-lock-store.ts`), not from an existing setting. Fake timers cannot move a separate worker process or the Postgres clock. Sharding already brings the critical path under the target.

Expected time per job after the caches are warm (estimates, not yet measured in CI):

| Job | Expected time |
| --- | --- |
| Backend shard (each of 4) | about 2.5 min setup + about 4.5 min tests = about 7 min |
| Contract shard (each of 5) | about 2.5 min setup + about 4.5 to 5 min tests = about 7 to 7.5 min |
| UI, CLI and CDK tests | about 3 min |
| Tests (merge check) | about 30 s after the last shard |
| Codesearch production build | about 2 to 3 min with a warm cache (419 s cold) |
| Storybook golden journey | about 7 min (unchanged) |
| Codesearch toolchain contracts | about 6 min (unchanged) |
| Typecheck, Vercel contracts | under 5 min (unchanged) |

Expected critical path: about 8 minutes, set by the slowest shard plus the merge check. The first run after a change to the caches is about 2 minutes slower.

Next step: give each native contract file its own OpenWorkflow namespace (see ticket 17, item 3), then set `fileParallelism` back to `true` in the shards.

Open risks:

- The run starts about 18 jobs at the same time. If the account concurrency limit is lower, jobs wait in the queue.
- The weights come from one run. Refresh `scripts/ci/test-weights.json` when a file becomes much slower.
