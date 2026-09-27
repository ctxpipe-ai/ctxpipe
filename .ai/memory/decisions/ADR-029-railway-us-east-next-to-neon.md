# ADR-029: Railway compute in US East next to Neon

**Status:** Accepted | **Date:** 2026-09-13 | **Tags:** infra, railway, neon, latency

## Context

Hosted product SQL uses Neon’s transaction-mode pooler in `aws-us-east-1`. Every org query is a short `BEGIN` + `SET LOCAL app.organization_id` + work + `COMMIT`. Railway production and every `pr-*` environment duplicated from it ran in `asia-southeast1-eqsg3a` (Singapore). That ~200ms RTT made each hop ~1s.

The module ignored `var.railway_regions` and hardcoded Singapore. There was no ADR or product reason for Asia. Railway `us-west2` (Oregon) would still be a cross-coast hop to Neon Virginia.

The Node/Bun DNS default prefers IPv6. A dead AAAA to Neon costs ~1s per new TCP connect (Happy Eyeballs). Region-only without IPv4-first still showed a ~1s floor.

`terraform apply` on merge (2026-09-14) planned Singapore → `us-east4-eqdc4a` and failed: Railway provider 0.6.1/0.6.2 `Update()` never sends `multiRegionConfig` ([issue #77](https://github.com/terraform-community-providers/terraform-provider-railway/issues/77)). Production stayed in Singapore. Upstream [PR #79](https://github.com/terraform-community-providers/terraform-provider-railway/pull/79) is unreleased.

## Decision

- Hosted Railway services run in **`us-east4-eqdc4a`** (Virginia), next to Neon **`aws-us-east-1`**.
- Desired region is **`var.railway_regions`**, defaulting to `[{ region = "us-east4-eqdc4a", num_replicas = 1 }]`. [`infra/main.tf`](../../../infra/main.tf) passes the same value. Provider 0.6.1 cannot convert a variable list (or a `for` over it) into `ServiceResourceRegionModel`; `local.regions` expands `var.railway_regions[0]` into an HCL object. The variable requires exactly one region.
- **Region writes on Update go through GraphQL**, not Terraform. [`scripts/railway-set-regions.sh`](../../../scripts/railway-set-regions.sh) sets `multiRegionConfig` (omit other regions; Railway rejects `numReplicas: 0`) and redeploys when the latest deployment is not already on that region. [`deploy.yaml`](../../../.github/workflows/deploy.yaml) runs the script before `terraform plan`/`apply`. Every `railway_service` uses `lifecycle.ignore_changes = [regions]` so the broken provider Update cannot fail the apply.
- PR preview environments stay a **production copy**. They inherit the production region after production actually moves. Do not pin preview services to a different region.
- The GraphQL pin + redeploy **is** the volume cutover. Codesearch and FalkorDB each have a 50GB volume; those deploys copy the volume and take the service down for the copy.
- Do not move Neon to `aws-us-west-2` unless Railway also moves to `us-west2`. Do not `SET SESSION` or hold a `PoolClient` across GitHub I/O.
- The backend sets `dns.setDefaultResultOrder("ipv4first")` before opening the pg pool.
- PR scale-to-zero sends `sleepApplication: true` only.

## Consequences

- Org SQL RTT drops from hundreds of milliseconds to a few milliseconds. Org-scoped hops should be tens of ms, not ~1s.
- A region flip is `scripts/railway-set-regions.sh` (via deploy), not `terraform apply` alone. Schedule the volume-copy window.
- After production is US East, new PR environments inherit that location. Existing `pr-*` environments that still show Singapore stay there until they are recreated.

## Alternatives considered

- **Railway `us-west2` only** — Rejected while Neon stays in Virginia; cross-coast RTT still costs hundreds of ms per org transaction.
- **Move Neon to `aws-us-west-2`** — Rejected; that is a project/branch recreate, not a Railway region flip.
- **Indexes / planner work for the 1s hops** — Rejected; PK gets and 2-row inserts were uniformly ~1050ms.
- **Pin PR previews to US East while production stays in Singapore** — Rejected; previews should remain a production copy.
- **Retry `terraform apply` for the region flip** — Rejected until the provider ships #79; Update never transmits `regions`.
- **Fork / vendor the Railway provider** — Deferred; GraphQL is the path we already proved.
