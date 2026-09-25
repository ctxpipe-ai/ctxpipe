# ctxpipe-observability Terraform

Provisions services, variables, `telemetry.ctxpipe.ai` (collector), `hyperdx.ctxpipe.ai` (dashboard), and `langfuse.ctxpipe.ai` in the **existing** Railway project `305aa114-c6f3-4aca-b883-0faa9c331aa2`. Does not create the Railway project or a Neon project.

ClickHouse, the collector, and `railway-telemetry` ([`railway-telemetry.tf`](./railway-telemetry.tf)) use the **Railway GitHub integration** (`source_repo` + `root_directory`). Image services (HyperDX, Langfuse, Redis, Mongo) pull public images. There is no `OBSERVABILITY_RAILWAY_TOKEN`.

`RAILWAY_API_TOKEN` on `railway-telemetry` is a Railway variable, not a Terraform variable. It must be able to read the observability and product projects. API reads do not wake sleeping services. Without it the cron still exports Redis `INFO` and exits 1.

`DEFAULT_CONNECTIONS` / `DEFAULT_SOURCES` on the hyperdx service (connection **`ctxpipe ClickHouse`**, sources Logs / Traces / Metrics / Sessions) apply only when a team is created and that team has no connections yet (sources only when it has none). They do not update an existing team. Dashboards are not Terraform; see [`../hyperdx/README.md`](../hyperdx/README.md).

The Railway bucket `langfuse-events` is created once outside this provider (0.6.1 has no bucket resource). Langfuse variables reference `${{langfuse-events.*}}`. The Railway bucket `clickhouse-cold` (region `iad`) is also created outside this provider. ClickHouse variables reference `${{clickhouse-cold.ENDPOINT}}`, `${{clickhouse-cold.BUCKET}}`, `${{clickhouse-cold.ACCESS_KEY_ID}}`, `${{clickhouse-cold.SECRET_ACCESS_KEY}}`, and `${{clickhouse-cold.REGION}}`.

## Apply

Supported path: [`.github/workflows/observability.yaml`](../../../.github/workflows/observability.yaml). A same-repo pull request plans only (GitHub Environment `terraform-plan`, which currently has no protection rules). Push to `main` and `workflow_dispatch` from `main` pin the region, plan, and apply. **Create GitHub Environment `observability` with required reviewers and a `main`-only deployment branch policy before merging.** If it is missing, the first push creates it with no rules and apply is ungated. The workflow adds no GitHub secrets. It uses existing `RAILWAY_TOKEN`, `R2_ACCESS_KEY_ID`, and `R2_SECRET_ACCESS_KEY` only.

Railway holds secret values. Terraform holds wiring (references such as `${{clickhouse.CLICKHOUSE_OTEL_PASSWORD}}`) and does not list the secret names, so apply cannot delete them. See the ownership table in [`../README.md`](../README.md).

`TF_VAR_github_repo_branch` is `main` for the PR plan and for apply.

Local apply uses the same import blocks and the same R2 key (`observability/terraform.tfstate`):

```bash
cd ops/observability/terraform
cp terraform.tfvars.example terraform.tfvars   # branch override only; secrets stay on Railway
terraform init \
  -backend-config="access_key=$R2_ACCESS_KEY_ID" \
  -backend-config="secret_key=$R2_SECRET_ACCESS_KEY"
terraform plan    # first plan: imports + in-place updates only
terraform apply
```

## Imports

[`imports.tf`](./imports.tf) adopts the API-created services. The first plan against empty state must show imports and in-place updates, not new `railway_service` creates and not a destroy or replace of `clickhouse` or `mongo`. Import blocks are no-ops once that address is in state.

`railway_variable_collection` import ids are `service_id:production:NAME:NAME:...` and list only names this module manages. Railway-owned secrets are not in those ids, so they never enter state and are not deleted. Live-only langfuse-web `NODE_OPTIONS` is omitted the same way. The first plan can still update a managed name from a literal to a Railway reference. The reference is meant to render the same value. CI hides those values, so compare them in the Railway dashboard before the first apply. Volumes are inline on `railway_service`: importing the service reads `clickhouse-data` and `mongo-data` in the project default environment (this project has only `production`). Provider Update creates a volume when state has none and config has one. The workflow guard rejects that update. Service domain subdomains are the live host labels (`collector-production-5b4c`, `hyperdx-production-1172`, `langfuse-web-production-f475`), which with suffix `up.railway.app` are the imported hostnames, so the first plan does not rename them. `ops-probe` and the `langfuse-events` bucket are not imported.

[`plan-guard.sh`](./plan-guard.sh) fails the plan and the apply when `terraform show -json` reports a `delete` action on any `railway_service`, `railway_custom_domain`, or `railway_variable_collection` (a replace is `delete` then `create`) or a service `update` whose `volume` before and after differ, including null to set. Computed volume `id` and `size` that are still unknown in `after` are not treated as a change.

Pin services to **`us-east4-eqdc4a`**. The apply job runs this before plan. Terraform create can land in the workspace preferred region (Singapore); `ignore_changes` plus provider issue #77 never fix it on apply:

```bash
RAILWAY_PROJECT_ID=305aa114-c6f3-4aca-b883-0faa9c331aa2 \
RAILWAY_SERVICE_SET=observability \
RAILWAY_ENVIRONMENT=production \
bash scripts/railway-set-regions.sh
```

`RAILWAY_TOKEN` must be able to manage `ctxpipe-observability`. The product workspace token used by `infra/` is enough; do not mint a second project token.

## Neon

Langfuse uses a dedicated database `langfuse` (role `langfuse`) on the existing `ctxpipe` Neon project. A schema on `neondb` is not supported — Langfuse Prisma migrations hardcode `public`. The langfuse-web Railway variables `DATABASE_URL` and `DIRECT_URL` include `connection_limit=1&keepalives=0`. The worker references those variables. `REDIS_SOCKET_TIMEOUT_MS=0` is set in Terraform. Set `idle_session_timeout=60s` on that database/role in Neon so idle Prisma sessions drop.

The provider cannot set Serverless. `sleepApplication` stays in `railway.toml` for the GitHub-built services and on the Railway service for images.

- Collector and ClickHouse set `sleepApplication = false` in their `railway.toml`.
- `railway_service.railway_telemetry` sets `cron_schedule = "*/5 * * * *"`. Provider 0.6.1 sends `cronSchedule` on every service update with no `omitempty`, so an unset attribute would clear the live cron. [`../railway-telemetry/railway.toml`](../railway-telemetry/railway.toml) uses the same schedule and `restartPolicyType = "NEVER"`. Keep those two strings equal. Terraform does not set `restartPolicyType`.
- HyperDX, Mongo, and Langfuse web stay Serverless (set on the Railway service). HyperDX sleeps. Mongo and Langfuse web stay up; see [`../README.md`](../README.md). Redis stays up because the Langfuse worker is always on. Do not add a timer that polls HyperDX, Mongo, or Langfuse web.
- HyperDX needs `OTEL_METRICS_EXPORTER=none` and `RUN_SCHEDULED_TASKS_EXTERNALLY=true` (traces and logs go to the private collector; a metric timer would block sleep). **Superseded:** `OTEL_SDK_DISABLED=true`. Langfuse worker is the stock always-on image (`node worker/dist/index.js`). Idle traces are capped with `LANGFUSE_QUEUE_METRICS_ENABLED=false`, `LANGFUSE_MONITOR_SCHEDULER_ENABLED=false`, `LANGFUSE_TRACE_DELETE_BATCH_ACTION_RUNNER_INTERVAL_MS=120000`, and `LANGFUSE_INGESTION_CLICKHOUSE_WRITE_INTERVAL_MS=20000`. The worker has no `OTEL_TRACES_SAMPLER`.
