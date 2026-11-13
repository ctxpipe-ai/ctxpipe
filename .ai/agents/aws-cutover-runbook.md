# AWS cutover runbook ([CTX-1217])

[CTX-1217]: https://linear.app/ctxpipe/issue/CTX-1217

This runbook moves hosted ctxpipe from Railway and Neon to AWS in one window. The plan, the rehearsals and their
results are in [CTX-1217], which links this file. Do each step in order. Do not start a step before the step before it shows its expected
output.

**Who:**

- **Person:** the CTO, or a person with the CTO's approval. Each person step needs production SSO admin, the Neon
  owner login, Railway access, or an approval of the edge stack. The agent has none of these.
- **Agent:** the cutover builder. It starts the one-off tasks with `hosted-run-task.yml` (factory), reads their logs,
  and runs `validateTarget`.

**Rollback point:** go/no-go G4. Before G4, each step has a rollback. After G4, there is no rollback: fix forward.

## Commands that this runbook uses

- Run a one-off task (agent): `gh workflow run hosted-run-task.yml -R ctxpipe-ai/factory --ref main -f task=<task>`.
  Then `gh run watch -R ctxpipe-ai/factory <run id>`. The task log is in the run. The tasks and their guards are in
  `machines/hosted/README.md#the-cutover-tasks` (factory).
- Neon SQL (person, owner login): `psql "$NEON_OWNER_URL" -tAc "<sql>"`. A statement with `$$` goes in a quoted
  heredoc, as G3 shows, so that the shell does not expand it. The SQL uses `current_database()` and needs no database
  name.
- Stop or start an AWS service (person):
  `aws ecs update-service --cluster hosted --service <backend|worker|ui|falkordb|codesearch> --desired-count <n>`.
- Validate a target (agent, from `apps/backend`): `bun run src/scripts/validateTarget.ts <origin>`. Load
  `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET` and `VALIDATE_API_KEY` into the environment from the secret store
  of the host. Do not type or print their values.

## Prerequisites (all must be true before T-1)

1. The entry criteria of [CTX-1217] hold, and two real rehearsals passed (gate G1 below).
2. The edge-stack pull requests for the day exist. They are reviewed and not merged:
   - (a) the maintenance page on `app.ctxpipe.ai`;
   - (b) `app.ctxpipe.ai` to the tunnel, behind a temporary Access app;
   - (c) the removal of the temporary Access app and of the `cutover.ctxpipe.dev` route.

   Each pull request shows its `pulumi preview`.
3. `hosted-run-task.yml` has the tasks `cutover-reset-database` and `cutover-migrate` too (see "Open items").
4. A test organization with a personal API key exists in production (Railway today), for the smoke check
   (`VALIDATE_API_KEY`).

## Dry run (the day before, changes nothing)

Do only the **dry run** line of each step below. Each dry run reads, or shows a plan. The dry run passes when each
line gives its expected output. The dry run of the copy is its preflight against Neon production.

## T-1 day

### G1: rehearsals passed

- **Who:** agent.
- **Check:** [CTX-1217] has the reports of two real rehearsals. Each has `"ok": true` from copy-database, no
  difference from verify-graph, and a window shorter than the planned length.
- **If not:** stop. Plan another rehearsal.

### 1. Production app secrets

- **Who:** person. **Do:** step C1 of [CTX-1217], production form. It copies the 23 `hosted/app/*` values from Railway,
  and the sha256 check prints `same` for each key. Then force a new deployment of the backend and the worker.
- **Dry run:** the sha256 check only (no `put-secret-value`).
- **Rollback:** write the rehearsal form again.

### 2. Deploy freeze

- **Who:** person. **Do:** stop merges to ctxpipe `main` and to factory `machines/hosted` until the window ends. Both
  platforms must run the same release, so that migrate adds no migration to the copy. A `hosted.yml` deploy would
  also start the stopped services again.
- **Expected:** Railway and AWS run the same backend image digest.

### 3. Customers

- **Who:** person. **Do:** tell the customers the window by hand. There is no status page.

## The window

### T-15 · G2: ready

- **Who:** agent, and a person for the secret.
- **Do:**
  1. Agent: HyperDX shows no error from the AWS services since their last deploy. The tunnel is connected.
  2. Person: fill `hosted/cutover/source-database-url` with the Neon production owner URL (direct host,
     `?sslmode=verify-full`).
  3. Agent: run the task `cutover-copy-database-preflight`.
- **Expected:** the report shows the `vector` version of both sides (the target the same or newer), the source size,
  and `sourceReadOnly: false`. Its `problems` is empty, or holds only "The target database has N schemas, … Restore
  only into an empty database." (T+3 empties the target).
- **Dry run:** the same. The preflight only reads.
- **If not:** stop. Nothing changed yet.

### T+0 · Writes stop

- **Who:** person.
- **Do:**
  1. Merge edge pull request (a): the maintenance page on `app.ctxpipe.ai`.
  2. Railway: set the replicas of the `backend` and `worker` services to 0. Codesearch and FalkorDB stay up.
  3. AWS: stop `backend`, `worker` and `ui` (desired count 0).
- **Expected:** `app.ctxpipe.ai` shows the maintenance page. Railway shows 0 replicas for both services.
- **Dry run:** the `pulumi preview` of pull request (a); `railway status`; `aws ecs describe-services`.
- **Rollback:** the full rollback.

### T+2 · G3: no writes on the old platform

- **Who:** person (Neon owner login).
- **Do:**
  1. Make new sessions read-only:

     ```sh
     psql "$NEON_OWNER_URL" <<'SQL'
     DO $$ BEGIN EXECUTE format('ALTER DATABASE %I SET default_transaction_read_only = on', current_database()); END $$;
     SQL
     ```

  2. End the remaining application sessions. The setting applies only to new sessions.

     ```sh
     psql "$NEON_OWNER_URL" -tAc "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = current_database() AND usename = 'ctxpipe_app'"
     ```

- **Check:** `SHOW default_transaction_read_only` prints `on`.
  `SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND usename = 'ctxpipe_app'` prints `0`.
- **Dry run:** the two check queries (expected now: `off`, and a count above 0). Also
  `PGOPTIONS='-c default_transaction_read_only=off' psql "$NEON_OWNER_URL" -tAc "SHOW transaction_read_only"` prints
  `off`: this is the session that the rollback uses.
- **Rollback:** a new session is read-only now, so open a read-write session to undo the setting:

  ```sh
  PGOPTIONS='-c default_transaction_read_only=off' psql "$NEON_OWNER_URL" <<'SQL'
  DO $$ BEGIN EXECUTE format('ALTER DATABASE %I SET default_transaction_read_only = off', current_database()); END $$;
  SQL
  ```

  Then do the full rollback.

### T+3 · Empty target

- **Who:** agent. **Do:** run the task `cutover-reset-database`. It drops the Aurora database `ctxpipe` and makes it
  again, empty.
- **Expected:** the task ends with exit code 0.
- **Dry run:** none. It changes AWS only.
- **Rollback:** none needed: AWS holds no customer write yet.

### T+5 · Copy (two in parallel)

- **Database (agent):** run the task `cutover-copy-database`.
  - **Expected:** the report has `"ok": true`, `preflight.sourceReadOnly: true`, `verify.problems` empty, and the
    phase times. Paste the times into [CTX-1217]. Never paste `pg_dump.log` or `pg_restore.log`: they can hold row
    data.
- **Indexes (person, in the shell of the Railway codesearch service):**
  1. Fill `hosted/cutover/transfer-url` with `s3://<shard bucket>/cutover-transfer/<run id>` (a new run id).
  2. With short-lived AWS credentials that can write only `cutover-transfer/*`, run:
     `cd /app/apps/codesearch && bun run cutover:export-indexes --to "s3://<shard bucket>/cutover-transfer/<run id>"`.
     It reads the FalkorDB URL from `GRAPH_DB_URI`.
  - **Expected:** a JSON report with the sizes, the sha256 values and the graph counts. `manifest.json` is in S3.
- **If either fails:** the full rollback. Write the cause into [CTX-1217].

### T+40 · Indexes into AWS

- **Who:** person stops and starts services; agent runs the tasks.
- **Do:**
  1. Stop `falkordb` and `codesearch` (desired count 0).
  2. Run the task `cutover-import-indexes`.
  3. Start `falkordb` (desired count 1). Run the task `cutover-verify-graph`.
  4. Run the task `cutover-seed-shard-store`. Then start `codesearch` (desired count 1).
- **Expected:** import checks each sha256 and count against the manifest. verify-graph reports no difference (it names
  graphs by position, with no organization id). seed-shard-store reports the count of names that it published.
- **Rollback:** the full rollback.

### T+50 · Migrate

- **Who:** agent. **Do:** run the task `cutover-migrate`: the `hosted-migrate` command on the restored database.
- **Expected:** the log shows `[migrate] done`. Then it shows `f|0`, the result of this query on the restored database
  (see "Open items"):
  `SELECT r.rolbypassrls, (SELECT count(*) FROM pg_auth_members m WHERE m.member = r.oid) FROM pg_roles r WHERE r.rolname = 'ctxpipe_app'`.
- **Dry run:** none. It changes AWS only.
- **Rollback:** the full rollback.

### T+55 · AWS up, behind Access

- **Who:** person (services and edge), agent (checks).
- **Do:**
  1. Person: start `backend` and `ui` (desired count 1). The worker stays at 0.
  2. Person: merge edge pull request (b): `app.ctxpipe.ai` to the tunnel, behind the temporary Access app.
  3. Agent: `validateTarget https://app.ctxpipe.ai` with the Access service token of the agent and the test API key.
  4. Agent: sign in with the test account. Read a graph and run a search on the test repository. Open the connectors
     page of the test organization: each connector shows as connected. Use only the test organization, and print no
     secret value and no id.
- **Expected:** every `validateTarget` check has `"ok": true`.
- **Dry run:** `validateTarget https://cutover.ctxpipe.dev --no-mcp-read`; the `pulumi preview` of pull request (b).
- **Rollback:** the full rollback.

### T+70 · G4: go/no-go (the rollback point)

- **Who:** the CTO decides; the agent reads the checklist out.
- **Check (each is a yes):** the G4 checklist of [CTX-1217]: the copy report, the graph and shard counts, migrate,
  the smoke check, HyperDX without errors, Neon still read-only, Railway still at 0, and the rollback ready.
- **Go:** the person sets the factory repository variable `CUTOVER_G4_PASSED` to `true`. After that, no copy task, no
  import and no reset of the database can run.
- **No-go:** the full rollback.

### T+75 · Writes open

- **Who:** person.
- **Do:**
  1. Start `worker` (desired count 1).
  2. Merge edge pull request (c): it removes the temporary Access app and the `cutover.ctxpipe.dev` route.
  3. Merge the factory pull request that removes the cutover tasks and `hosted-run-task.yml`. After this, no task can
     drop or overwrite the production data.
- **Expected:** customer traffic reaches AWS. The worker takes the open OpenWorkflow runs.
- **Rollback:** none. Fix forward.

### T+90 · After the window

- **Who:** agent, and a person for the webhook redeliveries and the access.
- **Do:**
  1. Person: redeliver the GitHub App webhook deliveries that failed in the window.
  2. Agent: start a reconcile sync of each connector. Watch the errors, the queue depth and the tunnel in HyperDX for
     one hour.
  3. Person: end the deploy freeze, and tell the customers.
  4. Person: retire the cutover access and the copies:
     - reset the password of the Neon owner role in the Neon console;
     - put `retired` into the two `hosted/cutover/*` secrets;
     - delete the Access service token of the agent, and revoke the API key of the test organization;
     - delete the transfer copies of every run, the rehearsals too. They hold the graphs and the source code of each
       organization, outside the deletion path of ctxpipe:
       `aws s3 rm --recursive "s3://<shard bucket>/cutover-transfer/"`. Then
       `aws s3 ls "s3://<shard bucket>/cutover-transfer/"` prints nothing.

## Full rollback (only before G4)

Do the steps that apply, in this order. Skip a step whose change was not made yet.

1. Neon: the rollback of G3 (read-write again).
2. Railway: set the replicas of `backend` and `worker` back to their values before T+0.
3. AWS: stop `backend`, `worker` and `ui`. The next window empties the target at T+3.
4. Revert edge pull request (b), if it was merged. Then revert (a): `app.ctxpipe.ai` goes back to Railway.
5. Write what failed into [CTX-1217], and plan the next window.

## Open items

- `cutover-reset-database` and `cutover-migrate` are not in `hosted-run-task.yml` yet. Both must refuse to run while
  `CUTOVER_G4_PASSED` is `true`: after G4, a reset would drop the production database.
  - Hosted migrate already ran on Aurora, so the copy needs an empty database first.
  - Hosted runs migrate only during `pulumi up`, once for each backend image. The dump keeps no roles, so the copy has
    no `ctxpipe_app`. The restored database therefore needs its own migrate task. The agent cannot reach Aurora, so
    that task must also run the role query of T+50 and print its result.
- The MCP evals cannot run against a deployed stack yet (the open point in [CTX-1217]).
- Delete this file in the pull request that removes the cutover tasks.
