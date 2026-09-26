# `infra/` (Terraform)

This directory replaces the Pulumi setup in `ops/infra/` with Terraform, while keeping `ops/infra/` intact as a reference.

## What this manages

Mirrors [ops/infra/index.ts](../ops/infra/index.ts):

- **Railway**
  - Project + `production` environment
  - Region: **`us-east4-eqdc4a`** (Virginia), from module variable `railway_regions` (default in [`module/ctxpipe/variables.tf`](module/ctxpipe/variables.tf); [`main.tf`](main.tf) passes the same value) — same metro as Neon. Terraform documents and creates with this value; **updates** go through [`scripts/railway-set-regions.sh`](../scripts/railway-set-regions.sh) (Railway provider 0.6.x never sends `multiRegionConfig` on Update).
  - Services: UI, backend, codesearch (+ volume), OpenWorkflow worker, FalkorDB (+ volume)
  - Service variables: `FALKORDB_PORT`, `GRAPH_DB_URI`
  - App services pull public GHCR images (`ghcr.io/ctxpipe-ai/{backend,worker,ui,codesearch}`) tagged by Git commit SHA from GitHub Actions (no Railway registry credentials)
  - **Volume cutover:** Railway migrates attached volumes when a service region changes ([docs](https://docs.railway.com/deployments/regions#volumes)). Codesearch and FalkorDB each have a 50GB volume. The production region write is `deploy.yaml` → `scripts/railway-set-regions.sh` (GraphQL pin + redeploy), not `terraform apply`. That step copies those volumes and takes those services down for the copy. Stateless services (backend, worker, UI) flip without volume migration. `railway_service` resources `ignore_changes` on `regions` so Terraform does not hit the provider Update bug. PR preview environments are a copy of production, so they inherit this region after production actually moves.
- **Neon**
  - Project `ctxpipe` in org `org-steep-pine-64462726`, region `aws-us-east-1`, pg 17
  - Default branch `production` with db `neondb` and role `neondb_owner`
  - Default endpoint autoscaling + maintenance window

## State backend (Cloudflare R2)

`backend.tf` is configured for an S3-compatible backend (R2). Do **not** commit real credentials; pass backend settings at init time:

```bash
terraform -chdir=infra init \
  -backend-config="bucket=YOUR_BUCKET" \
  -backend-config="key=ctxpipe/production/terraform.tfstate" \
  -backend-config="endpoints={s3=https://YOUR_ACCOUNT_ID.r2.cloudflarestorage.com}" \
  -backend-config="access_key=YOUR_R2_ACCESS_KEY_ID" \
  -backend-config="secret_key=YOUR_R2_SECRET_ACCESS_KEY"
```

## First-time adoption (import existing resources)

### 1) Initialize providers

```bash
terraform -chdir=infra init
```

### 2) Import Railway resources

You’ll need the **existing Railway IDs** (from Railway UI/API):

- **Project ID** (existing)
- **Service IDs** (existing): UI, backend, codesearch, worker, falkordb

Commands (replace IDs):

```bash
# Project
terraform -chdir=infra import module.ctxpipe.railway_project.this "YOUR_RAILWAY_PROJECT_ID"

# Environment: import format is project_id:environment_name
terraform -chdir=infra import module.ctxpipe.railway_environment.this "YOUR_RAILWAY_PROJECT_ID:production"

# Services (repeat per service key)
terraform -chdir=infra import 'module.ctxpipe.railway_service.this["ui"]' "YOUR_UI_SERVICE_ID"
terraform -chdir=infra import 'module.ctxpipe.railway_service.this["backend"]' "YOUR_BACKEND_SERVICE_ID"
terraform -chdir=infra import 'module.ctxpipe.railway_service.this["code_search"]' "YOUR_CODESEARCH_SERVICE_ID"
terraform -chdir=infra import 'module.ctxpipe.railway_service.this["open_workflow"]' "YOUR_OPENWORKFLOW_SERVICE_ID"
terraform -chdir=infra import 'module.ctxpipe.railway_service.this["falkordb"]' "YOUR_FALKORDB_SERVICE_ID"
```

Variables import support depends on provider capabilities. If import works for your version, you can import (otherwise: apply to start managing them going forward):

```bash
# Example addresses (Terraform import ID format is provider-specific)
terraform -chdir=infra import 'module.ctxpipe.railway_variable.service["falkordb:FALKORDB_PORT"]' "REPLACE_ME"
terraform -chdir=infra import 'module.ctxpipe.railway_variable.service["backend:GRAPH_DB_URI"]' "REPLACE_ME"
```

### 3) Import Neon resources

Import the Neon project by its existing project ID:

```bash
terraform -chdir=infra import module.ctxpipe.neon_project.this "YOUR_NEON_PROJECT_ID"
```

`neon_project` includes the default branch / endpoint settings. If your provider version represents those as separate resources (or you later decide you want independent lifecycle), we can split them out.

### 4) Confirm plan is safe

```bash
terraform -chdir=infra plan
```

If the plan wants to replace production resources, stop and we’ll adjust the configuration to match current reality before applying.

## Deploy image tags from CI

Production deploys are driven by `.github/workflows/deploy.yaml`:

- Build/push app images to GHCR with both `:<sha>` and `:latest`
- Run Terraform with `TF_VAR_image_tag=<sha>`
- Railway services are updated to `source_image = ghcr.io/ctxpipe-ai/<service>:<sha>`

Production OpenWorkflow / codesearch admission uses the **medium** capacity pair (`OPENWORKFLOW_CONCURRENCY=10`, `CODESEARCH_INDEXER_CONCURRENCY=2`, `CODESEARCH_INDEX_PIPELINE_CONCURRENCY=2`). Railway does not pin CPU/RAM in Terraform; pick these from observed ingest peak RSS (HyperDX / Railway metrics), not a dashboard plan size. Codesearch stays at **one replica** with a volume at `/data`. Changing these module variables requires redeploying **worker and codesearch**.

PR deploys are driven by `.github/workflows/pr-deploy.yaml`:

- Build/push PR images tagged `pr-<number>-<sha>` for **backend, worker, ui, codesearch**
- Update Railway PR environment service instances to those image tags via Railway GraphQL API
- Trigger deployments for backend, worker, ui, and codesearch in the PR environment
- Sets preview-only variables: `ENABLE_LANGSMITH=false`. OTLP endpoints stay the production values cloned with the environment (module `otel_otlp_endpoint` defaults to `https://telemetry.ctxpipe.ai`; PR uses flush-on-demand metrics; no 60s timer). Worker `OPENWORKFLOW_PR_IDLE_EXIT=true` + `OPENWORKFLOW_IDLE_EXIT_SECONDS=180` + `OPENWORKFLOW_IDLE_STALE_AFTER_HOURS=6` plus the **small** capacity pair (`OPENWORKFLOW_CONCURRENCY=6`, `CODESEARCH_INDEXER_CONCURRENCY=1`); codesearch `CODESEARCH_INDEXER_CONCURRENCY=1` + `CODESEARCH_INDEX_PIPELINE_CONCURRENCY=1`; backend `RAILWAY_TOKEN` to wake `openworkflow` after enqueue. PR backends also use short pg pool idle timeouts / no TCP keepAlive so Neon connections do not block Railway’s ~10m sleep window
- Enable **Serverless** on backend, ui, codesearch, openworkflow, and **FalkorDB**. Production Terraform does not create `otelcollector`. A preview environment that still has a copy is scaled to 0 and its active deployments are stopped (no `serviceInstanceDeployV2`)
- **Langfuse in PR**: shared ClickStack collector + `env:pr-N` tags; in-app Langfuse handler remains request-scoped
- For the PR **openworkflow worker**, image + Serverless + `restartPolicyType: ON_FAILURE` so idle supervisor exits (status 0) stay down until woken

## PR Terraform plans (GitHub Actions)

The workflow [.github/workflows/terraform-plan-pr.yaml](../.github/workflows/terraform-plan-pr.yaml) runs `terraform plan` on infra changes. Before it can run with production secrets:

1. Create a GitHub **Environment** named `terraform-plan` (Settings → Environments).
2. Add **required reviewers** (and optional wait timers) so the job only runs after infra approval. That limits unreviewed HCL executing with full Terraform secrets on in-repo branches.
3. Fork PRs skip this job by design (same-repo branches only).

