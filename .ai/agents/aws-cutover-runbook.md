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
  Then `gh run watch -R ctxpipe-ai/factory --exit-status <run id>`. The task log is in the run. The tasks are in
  `machines/hosted/README.md#the-cutover-tasks` (factory). The workflow refuses a task when its guard fails:
  - every copy-database task and `cutover-import-indexes`, while the repository variable `CUTOVER_G4_PASSED` is
    `true`;
  - `cutover-import-indexes`, until `falkordb` and `codesearch` are stopped (no task desired, running or pending);
  - `cutover-seed-shard-store`, until `codesearch` is stopped.
- Stop or start the stateful services and the worker on AWS (agent, factory#234): a scale action of `hosted.yml`,
  `gh workflow run hosted.yml -R ctxpipe-ai/factory --ref main -f action=<action>`, then
  `gh run watch -R ctxpipe-ai/factory --exit-status <run id>`. Start the next step only after the run succeeds. It
  deploys nothing, and it runs with the deploy role of `hosted.yml`:
  - `cutover-scale-down` sets `worker`, `falkordb` and `codesearch` to 0 and holds the worker's autoscaling at 0. The
    workflow refuses it after G4.
  - `cutover-scale-up-indexes` starts `falkordb` and `codesearch` again.
  - `cutover-scale-up-worker` starts the worker, and puts its autoscaling range back.

  Each one waits until the services are stable. No deploy undoes them: only these actions start the services again.
- Neon SQL (person, owner login): `psql "$NEON_OWNER_URL" -tAc "<sql>"`. A statement with `$$` goes in a quoted
  heredoc, as G3 shows, so that the shell does not expand it. The SQL uses `current_database()` and needs no database
  name.
- Stop or start `backend` or `ui` on AWS (person, production SSO; no task touches them):
  `aws ecs update-service --cluster hosted --service <backend|ui> --desired-count <0|1>`.
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
3. factory#166 is merged: `hosted-run-task.yml` has the cutover tasks, `cutover-reset-database`, `cutover-migrate` and
   `cutover-reset-indexes` included. Each of these three refuses while `CUTOVER_G4_PASSED` is `true`. factory#234 is
   merged too: it adds the three scale actions to `hosted.yml`.
4. The local rehearsal passes on the images of the day:
   `ops/aws-cutover/local-rehearsal/run.sh <backend image> <codesearch image>`. It runs the commands of the tasks.
5. The aws-core role `arn:aws:iam::213102790567:role/guard/cutover-transfer-writer` exists: the Railway export takes
   its credentials.
6. A test organization with a personal API key exists in production (Railway today), for the smoke check
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

- **Who:** person. **Do:** step C1 of [CTX-1217], production form. It copies 17 `hosted/app/*` values from Railway,
  and the sha256 check prints `same` for each key. `DATABASE_APP_PASSWORD` keeps its new value: migrate sets it.
  Then force a new deployment of the backend and the worker.
- **Copy, do not generate:** `AUTH_SECRET` (so that sessions stay valid) and `CONNECTION_SECRETS_ENCRYPTION_KEY` (so
  that the stored connector tokens decrypt) must have the production values. The rehearsals use new values for both;
  this step writes over them (ADR-061 decision 12).
- **Dry run:** the sha256 check only (no `put-secret-value`).
- **Rollback:** write the rehearsal form again. Make its new values in the form that the app requires, or the backend
  and the worker stop at start:
  - `CONNECTION_SECRETS_ENCRYPTION_KEY`: exactly 64 hex characters, `openssl rand -hex 32 | tr -d '\n'`.
  - `AUTH_SECRET`: `openssl rand -base64 48 | tr -d '\n'`.

### 2. Deploy freeze

- **Who:** person. **Do:** stop merges to ctxpipe `main` and to factory `machines/hosted` until the window ends. Both
  platforms must run the same release, so that migrate adds no migration to the copy. A `hosted.yml` deploy would
  also start `backend` and `ui` again; it does not undo the scale actions.
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

- **Who:** person; agent for step 4.
- **Do:**
  1. Merge edge pull request (a): the maintenance page on `app.ctxpipe.ai`.
  2. Railway: set the replicas of the `backend` and `openworkflow` (the worker) services to 0. Codesearch and FalkorDB
     stay up.
  3. AWS: stop `backend` and `ui` (desired count 0).
  4. Agent: run the scale action `cutover-scale-down` (the worker, FalkorDB and codesearch on AWS).
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
- **Indexes (person):**
  1. Fill `hosted/cutover/transfer-url` with `s3://<shard bucket>/cutover-transfer/<run id>` (a new run id).
  2. On your machine, get credentials that can write only `cutover-transfer/*`. They are valid for one hour:
     `aws sts assume-role --role-arn arn:aws:iam::213102790567:role/guard/cutover-transfer-writer --role-session-name railway-export --duration-seconds 3600 --query Credentials`.
     Also read the graph URL of the Railway `backend` service (the codesearch service has no `GRAPH_DB_URI`):
     `railway variables --service backend --environment production --json | jq -r .GRAPH_DB_URI`.
  3. Open the shell with `railway ssh --service codesearch --environment production`. Type `unset HISTFILE` first.
     Then enter each value without echo, for example `read -rs GRAPH_DB_URI && export GRAPH_DB_URI`, for
     `GRAPH_DB_URI`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` and `AWS_SESSION_TOKEN`. Then run
     `export AWS_REGION=us-west-2`.
  4. Run `cd /app/apps/codesearch && bun run cutover:export-indexes --to "s3://<shard bucket>/cutover-transfer/<run id>"`.
  5. Run `unset GRAPH_DB_URI AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN`, then close the shell with
     `exit`.
  - **Expected:** a JSON report with the sizes, the sha256 values and the graph counts. `manifest.json` is in S3.
- **If either fails:** the full rollback. Write the cause into [CTX-1217].

### T+40 · Indexes into AWS

- **Who:** agent. FalkorDB and codesearch are stopped since T+0.
- **Do:**
  1. Run the task `cutover-import-indexes`.
  2. Run the task `cutover-seed-shard-store`.
  3. Run the scale action `cutover-scale-up-indexes`.
  4. Run the task `cutover-verify-graph`.
- **Expected:** import checks each sha256 and count against the manifest. verify-graph reports no difference (it names
  graphs by position, with no organization id). seed-shard-store reports the count of names that it published.
- **Rollback:** the full rollback.

### T+50 · Migrate

- **Who:** agent. **Do:** run the task `cutover-migrate`: the `hosted-migrate` command on the restored database.
- **Expected:** the log shows `[migrate] done`. Then it shows `f|0`, the result of this query on the restored database.
  The task runs the query, because the agent cannot reach Aurora:
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

- **Who:** agent for step 1; person for steps 2 and 3.
- **Do:**
  1. Run the scale action `cutover-scale-up-worker`.
  2. Merge edge pull request (c): it removes the temporary Access app and the `cutover.ctxpipe.dev` route.
  3. Merge the factory pull requests that remove the cutover tasks, `hosted-run-task.yml` with its runner role
     `github-actions-hosted-run-task`, the scale actions of `hosted.yml`, and the role `guard/cutover-transfer-writer`.
     After their deploys, no task can drop or overwrite the production data. Check:
     - `aws iam get-role --role-name github-actions-hosted-run-task` and
       `aws iam get-role --role-name cutover-transfer-writer` each fail with `NoSuchEntity`;
     - `aws ecs list-task-definitions --family-prefix cutover- --status ACTIVE --query taskDefinitionArns` prints `[]`.
- **Expected:** customer traffic reaches AWS. The worker takes the open OpenWorkflow runs.
- **Rollback:** none. Fix forward.

### T+90 · After the window

- **Who:** agent, and a person for the webhook redeliveries and the access.
- **Do:**
  1. Person: redeliver the GitHub App webhook deliveries that failed in the window.
  2. Agent: start a reconcile sync of each connector. Watch the errors, the queue depth and the tunnel in HyperDX for
     one hour.
  3. Person: end the deploy freeze, and tell the customers.
  4. Person: [retire the cutover access and the copies](#retire-the-cutover-access-and-the-copies).

## Full rollback (only before G4)

Do the steps that apply, in this order. Skip a step whose change was not made yet.

1. Neon: the rollback of G3 (read-write again).
2. Railway: set the replicas of `backend` and `openworkflow` back to their values before T+0.
3. AWS: stop `backend` and `ui`. Agent: run the scale action `cutover-scale-down`, then the task
   `cutover-reset-database`, so that Aurora keeps no copy of the production data.
4. If T+40 started: agent, run the task `cutover-reset-indexes`. It empties both volumes and deletes the shards that
   `cutover-seed-shard-store` published, so that AWS keeps no copy of the graphs and the source code.
5. Agent: run the scale action `cutover-scale-up-indexes`, so that FalkorDB and codesearch run again. Do this step
   after each `cutover-scale-down`, also when step 4 did not apply.
6. Revert edge pull request (b), if it was merged. Then revert (a): `app.ctxpipe.ai` goes back to Railway.
7. Person: [retire the cutover access and the copies](#retire-the-cutover-access-and-the-copies). The next window
   makes the access again. The cutover tasks stay.
8. Write what failed into [CTX-1217], and plan the next window.

## Retire the cutover access and the copies

- **Who:** person.
- **When:** at T+90, or at the end of a full rollback.
- **Do:**
  1. Reset the password of the Neon owner role in the Neon console. If a Railway variable uses this login (for
     example the migrate URL), put the new password into it before the next Railway deploy.
  2. Put `retired` into the two `hosted/cutover/*` secrets.
  3. Delete the Access service token of the agent. Revoke the API key of the test organization.
  4. Delete the transfer copies of every run, the rehearsals too. They hold the graphs and the source code of each
     organization, outside the deletion path of ctxpipe:
     `aws s3 rm --recursive "s3://<shard bucket>/cutover-transfer/"`.
  5. Delete the seed file of the MCP evals, if one stays:
     `aws s3 rm --recursive "s3://<shard bucket>/cutover-mcp-evals/"`. It holds an API key of the eval test
     organizations. That key and those organizations exist only in the copy of a rehearsal: the task
     `cutover-reset-database` drops the copy after each rehearsal and again at T+3. The evals never run after G4.
- **Expected:** `aws s3 ls "s3://<shard bucket>/cutover-transfer/"` and
  `aws s3 ls "s3://<shard bucket>/cutover-mcp-evals/"` print nothing.

After a rollback, AWS still holds copies that no step deletes. AWS deletes them after a time:

- Aurora's automated backups: 7 days.
- The FalkorDB dump for the previews (`production/dump.rdb` in the dump bucket): until the next daily dump.
- The EBS volume backups, when they exist: 7 days, in a locked vault.

## Open items

- The MCP evals run in a rehearsal only, never in the window: they write test organizations. Run the task
  `cutover-mcp-evals-seed`, then `cutover-mcp-evals` (see `apps/backend/evals/mcp/README.md`). Both refuse to run
  while `CUTOVER_G4_PASSED` is `true`.
- Delete this file in the pull request that removes the cutover tasks.
