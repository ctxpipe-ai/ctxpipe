# ctxpipe-observability Terraform

Provisions the existing Railway project `ctxpipe-observability` (`305aa114-c6f3-4aca-b883-0faa9c331aa2`). Does not create the project or the Neon project.

ClickHouse, the collector, and `railway-telemetry` run CI images `ghcr.io/ctxpipe-ai/obs-<svc>:<git tree hash>`, where the tag is `git rev-parse HEAD:ops/observability/<svc>`. [`.github/workflows/observability.yaml`](../../../.github/workflows/observability.yaml) builds and pushes those images, then sets `TF_VAR_collector_image`, `TF_VAR_clickhouse_image`, and `TF_VAR_railway_telemetry_image`. Terraform `source_image` pins them. Railway pulls them without registry credentials, so the `obs-*` packages must be public; GitHub has no API for that, so set a new package public once in the org's package settings. HyperDX, Langfuse, Redis, and Mongo pull public images.

`clickhouse`, `collector`, `mongo`, `langfuse-web`, and `langfuse-worker` set `lifecycle { prevent_destroy = true }`. Plan and apply both refuse a plan that contains a delete:

```bash
jq -e '[.resource_changes[] | select(.change.actions | index("delete"))] | length == 0' plan.json
```

A replace is a delete followed by a create, so it fails the same check. An intentional removal uses a `removed` block with `lifecycle { destroy = false }`.

Railway holds secret values. Terraform holds references. Ownership: [../README.md](../README.md). `RAILWAY_API_TOKEN` on `railway-telemetry` is a Railway variable and must read the observability and product projects.

`DEFAULT_CONNECTIONS` and `DEFAULT_SOURCES` seed a new HyperDX team that has none. They do not update an existing team. Dashboards: [../hyperdx/README.md](../hyperdx/README.md).

Buckets `langfuse-events` and `clickhouse-cold` (region `iad`) are created outside this provider (0.6.1 has no bucket resource). Variables reference `${{langfuse-events.*}}` and `${{clickhouse-cold.*}}`.

`railway_service.railway_telemetry` sets `cron_schedule = "*/5 * * * *"`; provider 0.6.1 sends `cronSchedule` on every update with no `omitempty`, so an unset attribute would clear the live cron. Provider 0.6.1 cannot set restart policy, healthcheck path, or Serverless. They live on the Railway service (the live services have them; set them again only on a recreated service): clickhouse restart ON_FAILURE with 120 retries and healthcheck `/ping`; collector and clickhouse Serverless off; railway-telemetry restart NEVER. Sleep policy: [../README.md](../README.md#awake-vs-sleep).

## Apply

Supported path: [`.github/workflows/observability.yaml`](../../../.github/workflows/observability.yaml). A same-repo pull request plans only (GitHub Environment `terraform-plan`, `-lock=false`) and updates a comment headed `## Observability Terraform Plan`. Push to `main` and `workflow_dispatch` on `main` plan, refuse deletes, and apply (environment `observability`, concurrency group `observability-apply`, not cancelled when a newer run is queued). The workflow uses existing `RAILWAY_TOKEN`, `R2_ACCESS_KEY_ID`, and `R2_SECRET_ACCESS_KEY`. The state key `observability/terraform.tfstate` is in [`backend.tf`](./backend.tf).

After a successful apply the workflow pins region `us-east4-eqdc4a`. Provider 0.6.1 ignores regions on update (issue #77). The same command, from the repo root:

```bash
RAILWAY_PROJECT_ID=305aa114-c6f3-4aca-b883-0faa9c331aa2 \
RAILWAY_SERVICE_SET=observability \
RAILWAY_ENVIRONMENT=production \
bash scripts/railway-set-regions.sh
```

`RAILWAY_TOKEN` must be able to manage this project. The product workspace token is enough.

Local apply uses the same backend. Export the three `TF_VAR_*_image` tags, `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` (the R2 keys), and `RAILWAY_TOKEN`, then `terraform init`, `terraform plan`, and `terraform apply` from this directory.

## Imports

[`imports.tf`](./imports.tf) adopts the API-created services. It is a one-time import. Import blocks do nothing once that address is in state. Railway-owned secrets are omitted from the variable-collection import ids, so they never enter state.

## Fresh project

1. Railway project `ctxpipe-observability` exists. `has_pr_deploys = false`.
2. Create Neon database `langfuse`, role `langfuse`, on the existing `ctxpipe` project. Langfuse Prisma migrations use schema `public`. Set `idle_session_timeout=60s` on that database. `DATABASE_URL` and `DIRECT_URL` on langfuse-web include `connection_limit=1&keepalives=0`.
3. Create Railway buckets `langfuse-events` and `clickhouse-cold` (region `iad`).
4. Set the Railway-owned secrets in the [README table](../README.md#secrets). Collector `LANGFUSE_AUTH_STRING` is `base64(pk:sk)` of the Langfuse project keys. `RAILWAY_API_TOKEN` must read both projects.
5. Delete `imports.tf` first. Open a pull request that touches `ops/observability/**` and review the plan comment. The plan should create only `railway.tf` resources.
6. Merge to `main`. The workflow applies, then pins the region. A ClickHouse volume copy has downtime. Confirm both volumes are `us-east4-eqdc4a` before calling the stack done.
7. Create DNS CNAMEs for `telemetry.ctxpipe.ai`, `hyperdx.ctxpipe.ai`, and `langfuse.ctxpipe.ai` from `terraform output collector_dns_record`, `hyperdx_dns_record`, and `langfuse_dns_record`.
