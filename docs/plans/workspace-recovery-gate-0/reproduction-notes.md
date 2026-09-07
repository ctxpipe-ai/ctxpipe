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
`migrate-upgrade-reviewed`: the committed helper is invoked by its repository
relative path, creates a uniquely named database, and places its config in a
unique temporary directory without replacing developer files.

Durations of concurrent checks are not product latency. Skipped tests and missing
Docker/browser/journey evidence do not count as passes. Classification review
signals are search aids; only explicitly reviewed rows have been classified.
