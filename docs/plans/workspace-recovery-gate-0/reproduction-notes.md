# Reproduction and historical evidence

`evidence.tsv` selects the current accepted run for each check and links its exact
argv and log. `run-check.py` executes argv verbatim from the repository root;
callers explicitly include `volta run --node 22.16.0` when selecting Node 22.
It records cwd, argv, public fixture environment, timeout, exit and wall time,
and refuses to overwrite existing evidence. Use a unique name for each attempt.

The database port 51498 belongs to this disposable local run. Provision a fresh
pgvector/Postgres 17 instance and update the fixture URL before reproducing on
another host. Both roles use public test password `ctxpipe`; backend runtime
checks use `ctxpipe_app`, migrations use owner `ctxpipe`. No developer database
or model-provider credential is included in this bundle.

## Historical records

Earlier metadata does not have cwd/environment fields. Initial bare-pnpm commands
ran from the Documents recovery clone, with shell Node 24.14.1 but pnpm children
using Node 23.10.0. Their fixture environment matched the runner except that
AUTH_BASE_URL was http://localhost:3010 and backend tests used the owner role.
These explain the superseded UI HTTP mismatches and limit the initial backend
results. Typecheck/build diagnostics remain archived with that environment.

Clean `*-node22`, `tests-rls-clean`, and `opencode-live-clean` runs used
`/private/tmp/ctxpipe-recovery-01a07aba`, explicit Volta/Node 22.16.0, no
AUTH_BASE_URL override and application DB role for names starting `tests`.
The explicit OpenCode fallback test used the owner fixture URL, but does not
claim database-isolation proof; its model traffic goes to its own local stub.
The final runner also uses the application role for OpenCode checks.

The initial migration-upgrade log records an external scratch helper path that
is not a command to copy from this checkout. It is superseded in the ledger by
`migrate-upgrade-pinned-local`: the committed helper is invoked by its repository
relative path, creates a uniquely named database, and places its config in a
unique temporary directory without replacing developer files. Both migration trees
come from archived fixed Git revisions; the new database is dropped in `finally`.
The first pinned attempt was blocked by sandbox TCP access before database creation;
the explicitly allowed local rerun passed and recorded `DROP DATABASE`.

Durations of concurrent checks are not product latency. Skipped tests and missing
Docker/browser/journey evidence do not count as passes. Classification review
signals are search aids; only explicitly reviewed rows have been classified.

## Exit status provenance

The ledger records the outer process status captured by Python, not a status
parsed from pnpm text. Backend, codesearch-host and explicit OpenCode runs have
outer status **126**, while their pnpm output reports inner status **1**. A local
probe of `volta run --node 22.16.0 node -e 'process.exit(1)'` reproduces 126 both
inside and outside the sandbox (`volta-exit-status-probe` and
`volta-exit-status-local-probe`). Invoking the exact Node binary directly returns
1 (`node-direct-exit-status-probe`). These are wrapper diagnostics, not product
test failures. Original captured metadata is preserved.

The runner CLI regression fixture exercises missing arguments, literal argv and
cwd, overwrite refusal for both artifacts, and failing-child exit propagation.
`runner-cli-red.log` records the missing-argument failure before the fix;
`runner-cli-green.json` and `.log` record all four tests passing afterward.


## Completed browser, Docker and live diagnostic runs

Full Storybook metadata in `logs/storybook-full-browser-ui-cwd.json` records the
repo-root pnpm-filter invocation, UI execution cwd, external test-runner path and
Node 22.16.0. Browser tools are `@storybook/test-runner@0.24.4` and
`playwright@1.58.2` with its Chromium installed. Serve the built `apps/ui/storybook-static`
at localhost:6016. Install the named runner versions into an isolated tools
prefix if needed; no lockfile changes are required. The earlier root-cwd runner
attempt did not execute stories and is superseded.

Default codesearch Docker metadata is `logs/tests-codesearch-docker-cache-recovered.json`:
219 passed / 2 skipped, plus OOM simulation verified exit 137 and OOMKilled=true.
The skipped Node-only route cases are “returns files and dirs for pattern * by
default” and “matches dotpaths with default dot true”; Bun globFiles has 14 passing
tests in the same Docker command. This does not claim those exact skipped route
assertions executed. Gate 1 owns removal or explicit accounting of skipped proof.
The first Docker attempt failed Debian signature checks with Docker's virtual
volume full. A separate apt probe and disk evidence are retained. Approved
`docker builder prune --force --filter until=168h` reclaimed 10.52 GB of old,
regenerable build cache; no containers, images or volumes were removed. The
successful retry is separately named, not substituted into the failed log.

The user subsequently authorized use of the existing MODEL_PROVIDER_API_KEY.
The earlier approval rejection is historical. The live process loads only that
key; no key or GitHub App credential is in this evidence bundle.

### Recreate the disposable live fixture

Use the same runtime and pgvector/Postgres 17 fixture described above. Run full
migrations and provision app role. `start-fixture-server.py` uses the fixed local
ports and public test values in source, and expects the caller to supply an
already authorized MODEL_PROVIDER_API_KEY in its environment. From repo root:

```sh
python3 docs/plans/workspace-recovery-gate-0/start-fixture-server.py backend
python3 docs/plans/workspace-recovery-gate-0/start-fixture-server.py ui
python3 docs/plans/workspace-recovery-gate-0/start-fixture-server.py worker
```

These are separate long-running processes. The original run's key was loaded in
memory from the authorized developer dotenv file, never logged. OpenCode installed
on this host is **1.3.13** while the product contract pins **1.18.18**. Its existence
check accepted the older binary; this environment mismatch is recorded, not
assumed to cause any particular failure. Gate 1 must enforce its declared binary
version rather than silently accept this prerequisite mismatch.

Recreate the exact native commit with the committed bundle (only public fixture
README and AGENTS):

```sh
mkdir -p /private/tmp/ctxpipe-gate0-git-fixture
git clone --bare docs/plans/workspace-recovery-gate-0/native-fixture.bundle /private/tmp/ctxpipe-gate0-git-fixture/remote
```

On a fresh fixture, use real signup with name Gate Zero Fixture, email
`gate0@example.test`, password `gate0-disposable-local-password-20260907`; create
organization Gate Zero Local (`gate-zero-local`), skip optional connections and
invites, then create workspace from the file URL in `golden-journey.md`. IDs vary
between recreations; use the newly returned workspace ID in its documented SQL
bypasses. The measurement helper resolves the workspace by slug, and generates
fresh conversation IDs. The original before/after rows are in raw API/configuration
records. The fixed native commit allows exact SHA seeding after the failure.

```sh
python3 docs/plans/workspace-recovery-gate-0/measure-http-baseline.py /private/tmp/new-gate0-http-samples.jsonl
python3 docs/plans/workspace-recovery-gate-0/summarize-measurements.py /private/tmp/new-gate0-http-samples.jsonl
```

The follow-up instrumented series additionally sets PostgreSQL role-in-database
`log_statement=all`, `log_parameter_max_length=0`, and
`log_parameter_max_length_on_error=0` for ctxpipe_app in ctxpipe_gate0_fresh.
Existing task DB connections were terminated to acquire these session settings.
The browser was navigated away and task worker stopped. Capture Docker's database
logs over the sample UTC range; count `LOG: execute` and `LOG: statement` records,
including transaction statements, with parameter values disabled. Do not enable
this on a developer or production database. The helpers preserve failed samples
and create output exclusively; specify a new output path for every run.

Each measurement series deletes only its own generated conversations through the
production API. The final diagnostic cleans up the two manually used conversations
and checks sandbox rows, directory existence, leases, processes and sockets.
The task's database/container and servers are isolated from the original checkout.
