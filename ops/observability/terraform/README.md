# ctxpipe-observability Terraform

Provisions services, variables, `telemetry.ctxpipe.ai` (collector), `hyperdx.ctxpipe.ai` (dashboard), and `langfuse.ctxpipe.ai` in the **existing** Railway project `305aa114-c6f3-4aca-b883-0faa9c331aa2`. Does not create the Railway project or a Neon project.

ClickHouse, the collector, and `railway-telemetry` ([`railway-telemetry.tf`](./railway-telemetry.tf)) use the **Railway GitHub integration** (`source_repo` + `root_directory`). Image services (HyperDX, Langfuse, Redis, Mongo) pull public images. There is no `OBSERVABILITY_RAILWAY_TOKEN`.

`var.railway_api_token` is the workspace token for the `railway-telemetry` cron (`RAILWAY_API_TOKEN`). It must be able to read the observability and product projects. API reads do not wake sleeping services. Without it the cron still exports Redis `INFO` and exits 1.

`DEFAULT_CONNECTIONS` / `DEFAULT_SOURCES` on the hyperdx service (connection **`ctxpipe ClickHouse`**, sources Logs / Traces / Metrics / Sessions) apply only when a team is created and that team has no connections yet (sources only when it has none). They do not update an existing team. Dashboards are not Terraform; see [`../hyperdx/README.md`](../hyperdx/README.md).

The Railway bucket `langfuse-events` is created once outside this provider (0.6.1 has no bucket resource). Langfuse variables reference `${{langfuse-events.*}}`.

## Apply

```bash
cd ops/observability/terraform
cp terraform.tfvars.example terraform.tfvars   # fill secrets
terraform init \
  -backend-config="access_key=$R2_ACCESS_KEY_ID" \
  -backend-config="secret_key=$R2_SECRET_ACCESS_KEY"
terraform apply
```

First apply from this PR, before merge:

```bash
terraform apply -var='github_repo_branch=cursor/clickstack-langfuse-observability-8fbc'
```

After merge, apply again with `github_repo_branch=main`.

Then pin services to **`us-east4-eqdc4a`**. Terraform create can land in the workspace preferred region (Singapore); `ignore_changes` plus provider issue #77 never fix it on apply:

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
