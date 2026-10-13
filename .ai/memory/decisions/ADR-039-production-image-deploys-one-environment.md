# ADR-039: Production image deploys stay on one Railway environment

**Status:** Accepted | **Date:** 2026-09-28 | **Tags:** infra, railway, terraform

## Context

`railway_service` Update in provider 0.6.1 calls `serviceConnect`, which sets the Docker image for the whole project, then `serviceInstanceRedeploy` for every environment that service exists in, including `pr-*` forks.

On 2026-09-28, apply of `c22338c6` updated codesearch first ([job 108996933119](https://github.com/ctxpipe-ai/ctxpipe/actions/runs/36442191999/job/108996933119)). That redeployed `ghcr.io/ctxpipe-ai/codesearch:c22338c6…` onto every preview. Preview `pr-341` returned GraphQL `Problem processing request` (deployment left `INITIALIZING` with no region). Terraform aborted before backend and worker changed. Production codesearch reached the new image; backend and worker stayed on `8e72ee22`.

`serviceInstanceRedeploy` replays an existing deployment snapshot. PR deploys already pin an image with `serviceInstanceUpdate` and start it with `serviceInstanceDeployV2` on one environment id. Provider 0.6.2 still calls `redeployAllInstances` from Update.

## Decision

- SHA-tagged app services (`ui`, `backend`, `code_search`, `open_workflow`) set `lifecycle.ignore_changes` on `source_image` as well as `regions`.
- Production image writes are [`scripts/railway-set-images.sh`](../../../scripts/railway-set-images.sh), run from [`deploy.yaml`](../../../.github/workflows/deploy.yaml) before `terraform plan`. It sets `source.image` and calls `serviceInstanceDeployV2` only for the named environment (default `production`).
- Image repositories stay the module defaults in [`variables.tf`](../../../infra/module/ctxpipe/variables.tf). The script lists the same four repositories.
- FalkorDB keeps a Terraform `source_image` (`falkordb/falkordb`). It is not retagged on each commit. Changing that image still goes through provider Update.

## Consequences

- A production deploy no longer retags or redeploys preview environments.
- `terraform plan` on a SHA bump does not show those image changes. The script skips a service when that environment's source image already matches and the latest deployment is `SUCCESS` or `SLEEPING`. If `serviceInstanceUpdate` already started a deployment, the script waits for that deployment instead of calling `serviceInstanceDeployV2` on top of it. A deployment left `INITIALIZING` with no region is cancelled once it is stale, then a deploy is started. The image update includes `multiRegionConfig` for `us-east4-eqdc4a` so that deployment can be placed.
- Provider Update of any other `railway_service` attribute still calls `redeployAllInstances`. Do not put per-deploy changes on those resources besides the ignored fields.
- `serviceInstanceUpdate` on production also writes other non-fork environments. Production is the only non-fork; `pr-*` environments are forks and are left alone. The following deploy is still only production.

## Alternatives considered

- **Retry `terraform apply`** — Rejected. The next apply would redeploy every preview again and can fail the same way. Backend and worker would stay behind whenever one preview errors.
- **Upgrade the provider to 0.6.2** — Rejected. Update still redeploys every environment.
- **Fork the Railway provider** — Deferred. GraphQL is the path already used for regions ([ADR-029](ADR-029-railway-us-east-next-to-neon.md)) and PR deploys.
