# AWS cutover runbook (CTX-1217)

The day that moves hosted ctxpipe from Railway and Neon to AWS. The plan, the rehearsals and their results are in
[CTX-1217](https://linear.app/ctxpipe/issue/CTX-1217). This file is the procedure for the day. Do each step in order.
Do not start a step before the step before it shows its expected output.

**Who:**

- **Person:** the CTO, or a person with the CTO's approval. Has SSO admin in the production account, the Neon owner
  login, Railway access, and approves the edge-stack pull requests.
- **Agent:** the cutover builder. Starts the one-off tasks with `hosted-run-task.yml` (factory), reads their logs in
  HyperDX, and runs `validateTarget`.

**Rollback point:** go/no-go G4. Before G4, each step has a rollback. After G4, there is no rollback: fix forward.

## Commands that this runbook uses

- Run a one-off task (agent): `gh workflow run hosted-run-task.yml -R ctxpipe-ai/factory --ref main -f task=<task>`.
  Then `gh run watch -R ctxpipe-ai/factory <run id>`. The task log is in the run. The tasks and their guards are in
  `machines/hosted/README.md#the-cutover-tasks` (factory).
- Neon (person, owner login): `psql "$NEON_OWNER_URL" -tAc "<sql>"`. The SQL uses `current_database()`, so it needs no
  database name.
- Stop or start an AWS service (person):
  `aws ecs update-service --cluster hosted --service <backend|worker|ui|falkordb|codesearch> --desired-count <n>`.
- Validate a target (agent, from `apps/backend`):
  `CF_ACCESS_CLIENT_ID=… CF_ACCESS_CLIENT_SECRET=… VALIDATE_API_KEY=… bun run src/scripts/validateTarget.ts <origin>`.

## Prerequisites (all must be true before T-1)

1. The entry criteria of CTX-1217 hold, and two real rehearsals passed (gate G1 below).
2. The edge-stack pull requests for the day exist, reviewed, not merged: (a) the maintenance page on `app.ctxpipe.ai`,
   (b) `app.ctxpipe.ai` to the tunnel behind a temporary Access app, (c) remove the temporary Access app and the
   `cutover.ctxpipe.dev` route. Each one has a `pulumi preview` in its pull request.
3. `hosted-run-task.yml` has the tasks `cutover-reset-database` and `cutover-migrate` too (see "Open items").
4. A test organization with a personal API key exists in production (Railway today), for the smoke check
   (`VALIDATE_API_KEY`).

## Dry run (the day before, changes nothing)

Walk every step below and do only its **dry run** line: each one reads, or shows a plan. A dry run passes when each
line gives its expected output. The copy's dry run is its preflight against Neon production.

## T-1 day

### G1: rehearsals passed

- **Who:** agent.
- **Check:** CTX-1217 has the reports of two real rehearsals, each with `"ok": true` from copy-database, verify-graph
  with no difference, and a window below the planned length.
- **If not:** stop. Plan another rehearsal.

### 1. Production app secrets

- **Who:** person. **Do:** step C1 of CTX-1217, production form (copy the 23 `hosted/app/*` values from Railway; the
  sha256 check prints `same` for each key). Then force a new deployment of the backend and the worker.
- **Dry run:** the sha256 check only (no `put-secret-value`).
- **Rollback:** write the rehearsal form again.

### 2. Deploy freeze

- **Who:** person. **Do:** stop merges to ctxpipe `main` and to factory `machines/hosted` until the window ends. Both
  platforms must run the same release, so that migrate adds no migration to the copy. A `hosted.yml` deploy would
  also start the stopped services again.
- **Expected:** Railway and AWS run the same backend image digest.

### 3. Customers

- **Who:** person. **Do:** tell the customers the window by hand. No status page.

## The window

### T-15 · G2: ready

- **Who:** agent.
- **Do:**
  1. HyperDX shows the AWS services with no error since their last deploy. The tunnel is connected.
  2. Fill `hosted/cutover/source-database-url` (person) with the Neon production owner URL, direct host,
     `?sslmode=verify-full`.
  3. Run the task `cutover-copy-database-preflight`.
- **Expected:** the report has one problem only: "The target database has N schemas, … Restore only into an empty
  database." (hosted migrate ran on Aurora; T+3 empties it). It shows the `vector` version of both sides (target the
  same or newer), the source size, and `sourceReadOnly: false`.
- **Dry run:** the same (the preflight only reads).
- **If not:** stop. Nothing changed yet.

### T+0 · Writes stop

- **Who:** person.
- **Do:**
  1. Merge edge pull request (a): the maintenance page on `app.ctxpipe.ai`.
  2. Railway: set the replicas of the `backend` and `worker` services to 0. Codesearch and FalkorDB stay up.
  3. AWS: stop `backend`, `worker` and `ui` (desired count 0).
- **Expected:** `app.ctxpipe.ai` shows the maintenance page. Railway shows 0 replicas for both services.
- **Dry run:** the `pulumi preview` of pull request (a); `railway status`; `aws ecs describe-services`.
- **Rollback:** revert pull request (a); set the Railway replicas back; start the AWS services.

### T+2 · G3: no writes on the old platform

- **Who:** person (with the Neon owner URL), agent checks.
- **Do:**
  1. Make new sessions read-only:
     `DO $$ BEGIN EXECUTE format('ALTER DATABASE %I SET default_transaction_read_only = on', current_database()); END $$`
  2. End the remaining application sessions (the setting applies only to new sessions):
     `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = current_database() AND usename = 'ctxpipe_app'`
- **Check:** `SHOW default_transaction_read_only` prints `on`, and
  `SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND usename = 'ctxpipe_app'` prints `0`.
- **Dry run:** the two check queries only (expected now: `off`, and a count above 0).
- **Rollback:** step 1 with `off`, then the T+0 rollback.

### T+3 · Empty target

- **Who:** agent. **Do:** run the task `cutover-reset-database` (drops and makes again the empty Aurora database
  `ctxpipe`).
- **Expected:** the task ends with exit code 0.
- **Dry run:** none. It changes AWS only.
- **Rollback:** none needed: AWS holds no customer write yet.

### T+5 · Copy (two in parallel)

- **Database (agent):** run the task `cutover-copy-database`.
  - **Expected:** the report has `"ok": true`, `preflight.sourceReadOnly: true`, `verify.problems` empty, and the
    phase times. Paste the times into
    CTX-1217. Never paste `pg_dump.log` or `pg_restore.log` (they can hold row data).
- **Indexes (person, in the Railway codesearch service):**
  1. Fill `hosted/cutover/transfer-url` with `s3://<shard bucket>/cutover-transfer/<run id>` (a new run id).
  2. In the service shell, with short-lived AWS credentials that can write only `cutover-transfer/*`:
     `cd /app/apps/codesearch && bun run cutover:export-indexes --to "s3://<shard bucket>/cutover-transfer/<run id>"`
     (it reads the FalkorDB URL from `GRAPH_DB_URI`).
  - **Expected:** a JSON report with the sizes, the sha256 values and the graph counts; `manifest.json` is in S3.
- **If either fails:** rollback (below). The cause goes into CTX-1217.

### T+40 · Indexes into AWS

- **Who:** person stops and starts services; agent runs the tasks.
- **Do:**
  1. Stop `falkordb` and `codesearch` (desired count 0).
  2. Run the task `cutover-import-indexes`.
  3. Start `falkordb` (desired count 1). Run the task `cutover-verify-graph`.
  4. Run the task `cutover-seed-shard-store`. Then start `codesearch` (desired count 1).
- **Expected:** import checks each sha256 and count against the manifest; verify-graph reports no difference (graphs
  by position, no organization id); seed-shard-store reports the count of names it published.
- **Rollback:** none needed before G4 (AWS only).

### T+50 · Migrate

- **Who:** agent. **Do:** run the task `cutover-migrate` (the `hosted-migrate` command on the restored database).
- **Expected:** `[migrate] done`. `ctxpipe_app` has no `BYPASSRLS` and is a member of no role.

### T+55 · AWS up, behind Access

- **Who:** person (services and edge), agent (checks).
- **Do:**
  1. Start `backend` and `ui` (desired count 1). The worker stays at 0.
  2. Merge edge pull request (b): `app.ctxpipe.ai` to the tunnel, behind the temporary Access app.
  3. Agent: `validateTarget https://app.ctxpipe.ai` with the agent's Access service token and the test API key.
  4. Agent: sign in with the test account; read a graph and run a search on its test repository; decrypt check of
     the stored connector secrets.
- **Expected:** every `validateTarget` check has `"ok": true`.
- **Rollback:** revert pull request (b), then the full rollback.

### T+70 · G4: go/no-go (the rollback point)

- **Who:** the CTO decides; the agent reads the checklist out.
- **Check (each is a yes):** the G4 checklist of CTX-1217: the copy report, the graph and shard counts, migrate,
  the smoke check, HyperDX without errors, Neon still read-only, Railway still at 0, the rollback ready.
- **Go:** set the factory repository variable `CUTOVER_G4_PASSED` to `true` (person). From now on no copy task and no
  import runs.
- **No-go:** the full rollback.

### T+75 · Writes open

- **Who:** person.
- **Do:**
  1. Start `worker` (desired count 1).
  2. Merge edge pull request (c): remove the temporary Access app and the `cutover.ctxpipe.dev` route.
- **Expected:** customer traffic reaches AWS; the worker takes the open OpenWorkflow runs.
- **Rollback:** none. Fix forward.

### T+90 · After the window

- **Who:** agent, person for the redeliveries.
- **Do:** redeliver the GitHub App webhook deliveries that failed in the window; start a reconcile sync of each
  connector; watch errors, the queue depth and the tunnel in HyperDX for one hour; end the deploy freeze; tell the
  customers. Retire the cutover access as `machines/hosted/README.md#the-cutover-tasks` says.

## Full rollback (only before G4)

1. Revert the merged edge pull requests: `app.ctxpipe.ai` goes back to Railway, without the temporary Access app.
2. Neon: step 1 of G3 with `off`.
3. Railway: set the replicas of `backend` and `worker` back. Merge the revert of the maintenance page.
4. AWS: stop `backend`, `worker` and `ui`. Run the task `cutover-reset-database`.
5. Write what failed into CTX-1217, and plan the next window.

## Open items

- `cutover-reset-database` and `cutover-migrate` are not in `hosted-run-task.yml` yet. Hosted migrate already ran on
  Aurora, so the copy needs an empty database first. Hosted runs migrate only during `pulumi up`, once for each backend
  image, and the copy has no `ctxpipe_app` (the dump keeps no roles), so the restored database needs its own migrate
  task.
- The MCP evals cannot run against a deployed stack yet (the open point in CTX-1217).
