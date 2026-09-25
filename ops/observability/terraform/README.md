# ctxpipe-observability Terraform

Provisions services, variables, `telemetry.ctxpipe.ai` (collector), `hyperdx.ctxpipe.ai` (dashboard), and `langfuse.ctxpipe.ai` in the **existing** Railway project `305aa114-c6f3-4aca-b883-0faa9c331aa2`. Does not create the Railway project or a Neon project.

ClickHouse, the collector, and `railway-telemetry` ([`railway-telemetry.tf`](./railway-telemetry.tf)) use the **Railway GitHub integration** (`source_repo` + `root_directory`). Image services (HyperDX, Langfuse, Redis, Mongo) pull public images. There is no `OBSERVABILITY_RAILWAY_TOKEN`.

`var.railway_api_token` is the workspace token for the `railway-telemetry` cron (`RAILWAY_API_TOKEN`). It must be able to read the observability and product projects. API reads do not wake sleeping services. Without it the cron still exports Redis `INFO` and exits 1.

`DEFAULT_CONNECTIONS` / `DEFAULT_SOURCES` on the hyperdx service (connection **`ctxpipe ClickHouse`**, sources Logs / Traces / Metrics / Sessions) apply only when a team is created and that team has no connections yet (sources only when it has none). They do not update an existing team. Dashboards are not Terraform; see [`../hyperdx/README.md`](../hyperdx/README.md).

The Railway bucket `langfuse-events` is created once outside this provider (0.6.1 has no bucket resource). Langfuse variables reference `${{langfuse-events.*}}`.

## Apply

Supported path: [`.github/workflows/observability.yaml`](../../../.github/workflows/observability.yaml). A same-repo pull request plans only (GitHub Environment `terraform-plan`). Push to `main` and `workflow_dispatch` pin the region, plan, and apply (GitHub Environment `observability`; required reviewers can be turned on). See the secret table in [`../README.md`](../README.md).

GitHub secret values must match the live Railway variables. A mismatch rotates ClickHouse passwords, Langfuse keys, or the HyperDX ingest key and breaks the product OTLP header.

`TF_VAR_github_repo_branch` on a pull request is the PR head ref. On `main` it is `main`.

Local apply uses the same import blocks and the same R2 key (`observability/terraform.tfstate`):

```bash
cd ops/observability/terraform
cp terraform.tfvars.example terraform.tfvars   # copy live Railway values; do not mint new ones
terraform init \
  -backend-config="access_key=$R2_ACCESS_KEY_ID" \
  -backend-config="secret_key=$R2_SECRET_ACCESS_KEY"
terraform plan    # first plan: imports + in-place updates only
terraform apply
```

## Imports

[`imports.tf`](./imports.tf) adopts the API-created services. The first plan against empty state must show imports and in-place updates, not new `railway_service` creates and not a destroy or replace of `clickhouse` or `mongo`. Import blocks are no-ops once that address is in state.

`railway_variable_collection` import ids are `service_id:production:NAME:NAME:...` and list only names this module manages. Update deletes a name that is in state and missing from config. Live-only langfuse-web `NODE_OPTIONS` is not in the import id, so it is not deleted. Volumes are inline on `railway_service`: importing the service reads `clickhouse-data` and `mongo-data` in the project default environment (this project has only `production`). Provider Update creates a volume when state has none and config has one. The workflow guard rejects that update. Service domain subdomains are the live host labels (`collector-production-5b4c`, `hyperdx-production-1172`, `langfuse-web-production-f475`), which with suffix `up.railway.app` are the imported hostnames, so the first plan does not rename them. `ops-probe` and the `langfuse-events` bucket are not imported.

The workflow fails the plan and the apply when `terraform show -json` reports a `delete` action on any `railway_service` (a replace is `delete` then `create`) or an `update` whose `volume` before and after differ, including null to set. Computed volume `id` and `size` that are still unknown in `after` are not treated as a change.

Pin services to **`us-east4-eqdc4a`**. The apply job runs this before plan. Terraform create can land in the workspace preferred region (Singapore); `ignore_changes` plus provider issue #77 never fix it on apply:

```bash
RAILWAY_PROJECT_ID=305aa114-c6f3-4aca-b883-0faa9c331aa2 \
RAILWAY_SERVICE_SET=observability \
RAILWAY_ENVIRONMENT=production \
bash scripts/railway-set-regions.sh
```

`RAILWAY_TOKEN` must be able to manage `ctxpipe-observability`. The product workspace token used by `infra/` is enough; do not mint a second project token.

## Neon

Langfuse uses a dedicated database `langfuse` (role `langfuse`) on the existing `ctxpipe` Neon project. A schema on `neondb` is not supported — Langfuse Prisma migrations hardcode `public`. Locals append `connection_limit=1&keepalives=0` to `DATABASE_URL` / `DIRECT_URL` and set `REDIS_SOCKET_TIMEOUT_MS=0`. Set `idle_session_timeout=60s` on that database/role in Neon so idle Prisma sessions drop.

The provider cannot set Serverless. This module does not set a `cron_schedule` attribute. `sleepApplication` and the `railway-telemetry` schedule live in `railway.toml`, which the Railway deploy reads (`config_path`). They are not Terraform attributes:

- Collector and ClickHouse set `sleepApplication = false` in their `railway.toml`.
- `railway-telemetry` sets `cronSchedule = "*/5 * * * *"` and `restartPolicyType = "NEVER"` in [`../railway-telemetry/railway.toml`](../railway-telemetry/railway.toml). Terraform only sets `config_path` to that file. Provider 0.6.1 has a `cron_schedule` attribute and does not read this file.
- HyperDX, Mongo, and Langfuse web stay Serverless (set on the Railway service). Redis stays up because the Langfuse worker is always on; do not add a timer that polls the sleep set.
- HyperDX needs `OTEL_METRICS_EXPORTER=none` and `RUN_SCHEDULED_TASKS_EXTERNALLY=true` (traces and logs go to the private collector; a metric timer would block sleep). **Superseded:** `OTEL_SDK_DISABLED=true`. Langfuse worker is the stock always-on image (`node worker/dist/index.js`).
