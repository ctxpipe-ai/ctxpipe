# ctxpipe-observability Terraform

Provisions the existing Railway project `ctxpipe-observability` (`305aa114-c6f3-4aca-b883-0faa9c331aa2`). Does not create the project or the Neon project.

ClickHouse, the collector, `railway-telemetry`, and `cost-telemetry` run CI images `ghcr.io/ctxpipe-ai/obs-<svc>:<git tree hash>`, where the tag is `git rev-parse HEAD:ops/observability/<svc>`. [`.github/workflows/observability.yaml`](../../../.github/workflows/observability.yaml) builds and pushes those images, then sets `TF_VAR_collector_image`, `TF_VAR_clickhouse_image`, `TF_VAR_railway_telemetry_image`, and `TF_VAR_cost_telemetry_image`. Terraform `source_image` pins ClickHouse, the collector, and `railway-telemetry`. `cost-telemetry` is created without a source; `terraform_data.cost_telemetry_source_image` connects `var.cost_telemetry_image` after `restartPolicyType=NEVER`. Railway pulls them without registry credentials, so the `obs-*` packages must be public; GitHub has no API for that, so set a new package public once in the org's package settings. HyperDX, Langfuse, Redis, and Mongo pull public images.

`clickhouse`, `collector`, `mongo`, `langfuse-web`, and `langfuse-worker` set `lifecycle { prevent_destroy = true }`. Plan and apply both refuse a plan that contains a delete, except a replace of `terraform_data.cost_telemetry_source_image` (image updates recreate that helper). A bare delete of that resource still fails:

```bash
jq -e '[.resource_changes[] | select((.change.actions | index("delete")) and (.address != "terraform_data.cost_telemetry_source_image" or (.change.actions | index("create") | not)))] | length == 0' plan.json
```

A replace is a delete followed by a create, so every other replace fails the same check. An intentional removal uses a `removed` block with `lifecycle { destroy = false }`.

Railway holds runtime secret values. Terraform holds references. Ownership: [../README.md](../README.md). `RAILWAY_API_TOKEN` on `railway-telemetry` is a Railway variable and must read the observability and product projects. The protected GitHub `observability` Environment holds source copies of the `cost-telemetry` provider credentials; [`sync-cost-telemetry-variables.py`](./sync-cost-telemetry-variables.py) writes them to Railway before the image is connected and after each apply. The values do not enter Terraform inputs, plan output, or state.

`DEFAULT_CONNECTIONS` and `DEFAULT_SOURCES` seed a new HyperDX team that has none. They do not update an existing team. Dashboards: [../hyperdx/README.md](../hyperdx/README.md).

Buckets `langfuse-events` and `clickhouse-cold` (region `iad`) are created outside this provider (0.6.1 has no bucket resource). Variables reference `${{langfuse-events.*}}` and `${{clickhouse-cold.*}}`.

`railway_service.railway_telemetry` sets `cron_schedule = "*/5 * * * *"`; `railway_service.cost_telemetry` sets `cron_schedule = "17 * * * *"` and omits `source_image`. Provider 0.6.1 sends `cronSchedule` on every update with no `omitempty`, so an unset attribute would clear the live cron. The provider has no `restartPolicyType` argument; Create and Update omit it (`omitempty`). Provider Create() calls `connectService` when `source_image` is set, which can start a deploy at the platform default `ON_FAILURE` before NEVER is written. Create order for `cost-telemetry`: empty service → `terraform_data.cost_telemetry_restart_never` ([`set-restart-policy-never.sh`](./set-restart-policy-never.sh): `serviceInstanceUpdate` `restartPolicyType: NEVER`, then a read-back) → `railway_variable_collection.cost_telemetry` (OTLP header) → `terraform_data.cost_telemetry_source_image` ([`connect-source-image-and-deploy.sh`](./connect-source-image-and-deploy.sh): sync GitHub Environment provider credentials with `skipDeploys`, connect `source.image`, read back, call `serviceInstanceDeployV2`, then poll until `SUCCESS`/`SLEEPING` or `FAILED`/`CRASHED`/timeout). The connect resource's trigger is the service id plus `var.cost_telemetry_image`, so an image change redeploys without rewriting NEVER. After every apply, the workflow syncs the credentials again and redeploys only if a value changed. `lifecycle.ignore_changes` includes `source_image` so a later Read of the live image does not disconnect it. Later applies do not re-run the NEVER mutation; omitempty leaves the value in place. `railway-telemetry` is already `NEVER` on the live service. ClickHouse and the collector use the platform default, `ON_FAILURE` with 10 retries. Sleep policy: [../README.md](../README.md#awake-vs-sleep).

## Apply

Supported path: [`.github/workflows/observability.yaml`](../../../.github/workflows/observability.yaml). A same-repo pull request plans only (GitHub Environment `terraform-plan`, `-lock=false`) and updates a comment headed `## Observability Terraform Plan`. Push to `main` and `workflow_dispatch` on `main` plan, refuse deletes, and apply (environment `observability`, concurrency group `observability-apply`, not cancelled when a newer run is queued). The workflow uses existing `RAILWAY_TOKEN`, `R2_ACCESS_KEY_ID`, and `R2_SECRET_ACCESS_KEY`. The state key `observability/terraform.tfstate` is in [`backend.tf`](./backend.tf).

After a successful apply the workflow pins region `us-east4-eqdc4a`. Provider 0.6.1 ignores regions on update (issue #77). The pin walks every service in the project and skips one that has no instance in production, such as a Railway Function that is only staged. The same command, from the repo root:

```bash
RAILWAY_PROJECT_ID=305aa114-c6f3-4aca-b883-0faa9c331aa2 \
RAILWAY_SERVICE_SET=observability \
RAILWAY_ENVIRONMENT=production \
bash scripts/railway-set-regions.sh
```

`RAILWAY_TOKEN` must be able to manage this project. The product workspace token is enough.

Local apply uses the same backend. Export the four `TF_VAR_*_image` tags, `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` (the R2 keys), `RAILWAY_TOKEN`, and the `COST_TELEMETRY_*` values from their original credential source, then `terraform init`, `terraform plan`, and `terraform apply` from this directory. GitHub Actions is the supported path because GitHub secret values cannot be read back. Creating or replacing `cost-telemetry`, or changing `TF_VAR_cost_telemetry_image`, runs the local-exec GraphQL helpers; those need `RAILWAY_TOKEN`, `curl`, `jq`, and Python 3. The source-image helper waits up to 600s for a terminal Railway deploy status and fails the apply on `FAILED`, `CRASHED`, or timeout.

## Fresh project

1. Railway project `ctxpipe-observability` exists. `has_pr_deploys = false`.
2. Create Neon database `langfuse`, role `langfuse`, on the existing `ctxpipe` project. Langfuse Prisma migrations use schema `public`. Set `idle_session_timeout=60s` on that database. `DATABASE_URL` and `DIRECT_URL` on langfuse-web include `connection_limit=1&keepalives=0`.
3. Create Railway buckets `langfuse-events` and `clickhouse-cold` (region `iad`).
4. Set the Railway-owned secrets in the [README table](../README.md#secrets). Collector `LANGFUSE_AUTH_STRING` is `base64(pk:sk)` of the Langfuse project keys. `RAILWAY_API_TOKEN` must read both projects.
5. Open a pull request that touches `ops/observability/**` and review the plan comment. The plan should create only `railway.tf` resources.
6. Merge to `main`. The workflow applies, then pins the region. A ClickHouse volume copy has downtime. Confirm both volumes are `us-east4-eqdc4a` before calling the stack done.
7. Create DNS CNAMEs for `telemetry.ctxpipe.ai`, `hyperdx.ctxpipe.ai`, and `langfuse.ctxpipe.ai` from `terraform output collector_dns_record`, `hyperdx_dns_record`, and `langfuse_dns_record`.
