# `infra/` (Terraform)

This directory replaces the Pulumi setup in `ops/infra/` with Terraform, while keeping `ops/infra/` intact as a reference.

## What this manages

Mirrors [ops/infra/index.ts](../ops/infra/index.ts):

- **Railway**
  - Project + `production` environment
  - Region: **`us-east4-eqdc4a`** (Virginia), from module variable `railway_regions` (default in [`module/ctxpipe/variables.tf`](module/ctxpipe/variables.tf); [`main.tf`](main.tf) passes the same value) — same metro as Neon. Terraform documents and creates with this value; **updates** go through [`scripts/railway-set-regions.sh`](../scripts/railway-set-regions.sh) (Railway provider 0.6.x never sends `multiRegionConfig` on Update). Do not hardcode Singapore in the module.
  - Services: UI, backend, codesearch (+ volume), OpenWorkflow worker, FalkorDB (+ volume)
  - Service variables: `FALKORDB_PORT`, `GRAPH_DB_URI`
  - App services pull public GHCR images (`ghcr.io/ctxpipe-ai/{backend,worker,ui,codesearch}`) tagged by Git commit SHA from GitHub Actions (no Railway registry credentials). Production tag updates are [`scripts/railway-set-images.sh`](../scripts/railway-set-images.sh), not `railway_service` Update (ADR-039).
  - **Volume cutover:** Railway migrates attached volumes when a service region changes ([docs](https://docs.railway.com/deployments/regions#volumes)). Codesearch and FalkorDB each have a 50GB volume. The production region write is `deploy.yaml` → `scripts/railway-set-regions.sh` (GraphQL pin + redeploy), not `terraform apply`. That step copies those volumes and takes those services down for the copy. Stateless services (backend, worker, UI) flip without volume migration. `railway_service` resources `ignore_changes` on `regions` so Terraform does not hit the provider Update bug. PR preview environments are a copy of production, so they inherit this region after production actually moves.
  - **Project settings:** `railway_project.this` has `ignore_changes = all`. Railway provider 0.6.1 `Update()` reads the first environment that Railway returns as `default_environment`, so an update fails when a `pr-*` environment comes first. Change the project name, description, privacy, or PR deploys in the Railway UI. A postcondition stops the plan when the oldest environment is not `production`, because every `railway_variable` writes to `default_environment.id`.
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
- Run [`scripts/railway-set-images.sh`](../scripts/railway-set-images.sh) with `IMAGE_TAG=<sha>` so production `backend`, `ui`, `openworkflow`, and `codesearch` deploy that tag. The script updates and deploys only the production environment.
- Run Terraform with `TF_VAR_image_tag=<sha>`. `source_image` is `ignore_changes` on those four services, so apply does not call the provider Update that redeploys every environment.

Production OpenWorkflow / codesearch admission uses the **medium** capacity pair (`OPENWORKFLOW_CONCURRENCY=10`, `CODESEARCH_INDEXER_CONCURRENCY=2`, `CODESEARCH_INDEX_PIPELINE_CONCURRENCY=2`). Railway does not pin CPU/RAM in Terraform; pick these from observed ingest peak RSS (HyperDX / Railway metrics), not a dashboard plan size. Codesearch stays at **one replica** with a volume at `/data`. Changing these module variables requires redeploying **worker and codesearch**.

PR deploys are driven by `.github/workflows/pr-deploy.yaml`:

- Build/push PR images tagged `pr-<number>-<sha>` for **backend, worker, ui, codesearch**
- Update Railway PR environment service instances to those image tags via Railway GraphQL API
- Trigger deployments for backend, worker, ui, and codesearch in the PR environment
- OTLP exporter vars are re-synced on every PR roll by `scripts/preview-otel-vars.sh` (`sync_preview_otel_variables`, sourced by `pr-deploy.yaml` and `pr-preview-roll-existing.yaml`) from the four exporter variables of the production backend (fallback: `OBSERVABILITY_OTLP_HEADERS` + `https://telemetry.ctxpipe.ai`). Clone-at-create is not enough for long-lived `pr-*` envs created before ClickStack. Module `otel_otlp_endpoint` defaults to `https://telemetry.ctxpipe.ai`; PR uses flush-on-demand metrics; no 60s timer. Worker `OPENWORKFLOW_PR_IDLE_EXIT=true` + `OPENWORKFLOW_IDLE_EXIT_SECONDS=180` + `OPENWORKFLOW_IDLE_STALE_AFTER_HOURS=6` plus the **small** capacity pair (`OPENWORKFLOW_CONCURRENCY=6`, `CODESEARCH_INDEXER_CONCURRENCY=1`); codesearch `CODESEARCH_INDEXER_CONCURRENCY=1` + `CODESEARCH_INDEX_PIPELINE_CONCURRENCY=1`; backend `RAILWAY_TOKEN` to wake `openworkflow` after enqueue. PR backends also use short pg pool idle timeouts / no TCP keepAlive so Neon connections do not block Railway’s ~10m sleep window
- Hosted chat sandboxes: `scripts/preview-sandbox-vars.sh` (`sync_preview_sandbox_variables`, sourced by `pr-deploy.yaml` and `pr-preview-roll-existing.yaml`) sets `SANDBOX_PROVIDER=vercel`, `VERCEL_TOKEN` (GitHub secret `VERCEL_ACCESS_TOKEN`), `VERCEL_TEAM_ID` and `VERCEL_PROJECT_ID` on backend and worker; production gets the same from the module (`vercel_access_token`). Previews and CI use the preview Vercel project `ctxpipe-previews`; production uses `ctxpipe`. `VERCEL_ACCESS_TOKEN` is an environment secret, not a repository secret: the jobs that touch previews or CI run in the GitHub environment `Preview` (token for the preview project only), and the production deploy runs in `Production`. The PR Terraform plan gets a placeholder token, not the production token. Sandboxes are tagged with the Railway environment name, and the PR-close job `cleanup_pr_sandboxes` deletes that preview's sandboxes and saved snapshots (`apps/backend/src/scripts/deletePreviewSandboxes.ts`). Each production deploy runs the same script with `pr-*` against the production project: it deletes the sandboxes that previews left there before they moved to the preview project (only an `environment` tag of exactly `pr-<number>`)
- Preview GitHub App: `scripts/preview-github-app-vars.sh` (`sync_preview_github_app_variables`, sourced by `pr-deploy.yaml` and `pr-preview-roll-existing.yaml`) sets `GITHUB_APP_ID`, `GITHUB_APP_SLUG`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `GITHUB_PRIVATE_KEY` and `GITHUB_WEBHOOK_SECRET` on backend and worker. The values come from the secrets `GH_APP_ID`, `GH_APP_SLUG`, `GH_CLIENT_ID`, `GH_CLIENT_SECRET`, `GH_PRIVATE_KEY` and `GH_WEBHOOK_SECRET` of the GitHub environment `Preview` (GitHub rejects secret names that start with `GITHUB_`). Every environment uses the same names. A job in an environment also reads the repository secrets, so a missing `Preview` secret falls back to a repository secret with the same name. Keep production App secrets in the production environment, not at repository level. A preview runs branch code that nobody has reviewed, so it must not keep the production App that `environment new --duplicate production` copies. An empty secret fails the deploy. The PR comment links the preview App settings, where a person adds the preview callback URL
- Preview secrets: `scripts/preview-own-secrets.sh` (`sync_preview_own_secrets`, sourced by `pr-deploy.yaml` and `pr-preview-roll-existing.yaml`) gives each preview its own random `AUTH_SECRET` and `CONNECTION_SECRETS_ENCRYPTION_KEY` on backend, worker, ui and codesearch, in place of the production values that `environment new --duplicate production` copies. The backend variable `PREVIEW_OWN_SECRETS=v1` records this, so later rolls keep the values for the life of the preview. Connection secrets copied from production do not decrypt on a preview; connect each integration again there. The same step creates a Railway project token for the preview environment only (`projectTokenCreate`) and sets it as the backend `RAILWAY_TOKEN` for worker wake. If Railway does not create it, the deploy stops; it never falls back to the account token. The PR-close cleanup deletes the project tokens of the preview environment (`projectTokenDelete`) before it deletes the environment. The GitHub secret `RAILWAY_API_TOKEN` (account token) goes only to the Railway steps of the deploy job, not to `pnpm install` or the migrations, and never into a service variable. No other secret is necessary for this
- Preview GitHub App guard: the deploy also fails when the Preview `GH_APP_ID` or `GH_CLIENT_ID` is equal to `GITHUB_APP_ID` or `GITHUB_CLIENT_ID` on the production backend, because a missing `Preview` secret falls back to a repository secret. The OTEL sync and this guard read only the variables they name from the production backend (`production_backend_vars` in `scripts/preview-service-vars.sh`)
- Enable **Serverless** on backend, ui, codesearch, openworkflow, and **FalkorDB**.
- **Langfuse in PR**: shared ClickStack collector + `env:pr-N` tags; in-app Langfuse handler remains request-scoped
- For the PR **openworkflow worker**, image + Serverless + `restartPolicyType: ON_FAILURE` so idle supervisor exits (status 0) stay down until woken

## Connection secrets key

The module sets `CONNECTION_SECRETS_ENCRYPTION_KEY` on backend and worker from the GitHub secret of the same name in `production` (`openssl rand -hex 32`). Without it, the key comes from `AUTH_SECRET`. The PR plan gets a placeholder.

To move the stored connection secrets to a new key:

1. Stop backend and worker. Do not merge to `main` until step 4.
2. In Railway, set the new key on `backend` and `openworkflow` without a redeploy. Deploy starts the images before Terraform sets variables.
3. From `apps/backend`, with `DATABASE_URL` (owner URL), `OLD_AUTH_SECRET` and `NEW_CONNECTION_SECRETS_ENCRYPTION_KEY` exported, run `bun run src/scripts/reencryptConnectionSecrets.ts`, then the same with `--apply`.
4. Set the same key in the GitHub secret, then push to `main`. "Run workflow" skips Terraform.

## PR Terraform plans (GitHub Actions)

The workflow [.github/workflows/terraform-plan-pr.yaml](../.github/workflows/terraform-plan-pr.yaml) runs `terraform plan` on infra changes. Before it can run with production secrets:

1. Create a GitHub **Environment** named `terraform-plan` (Settings → Environments).
2. Add **required reviewers** (and optional wait timers) so the job only runs after infra approval. That limits unreviewed HCL executing with full Terraform secrets on in-repo branches.
3. Fork PRs skip this job by design (same-repo branches only).

