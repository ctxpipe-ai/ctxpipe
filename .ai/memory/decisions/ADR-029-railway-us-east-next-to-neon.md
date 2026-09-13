# ADR-029: Railway compute in US East next to Neon

**Status:** Accepted | **Date:** 2026-09-13 | **Tags:** infra, railway, neon, latency

## Context

Hosted product SQL uses Neon’s transaction-mode pooler in `aws-us-east-1`. Every org query is a short `BEGIN` + `SET LOCAL app.organization_id` + work + `COMMIT`. Railway production and every `pr-*` environment duplicated from it ran in `asia-southeast1-eqsg3a` (Singapore). That ~200ms RTT made each hop ~1s.

The module ignored `var.railway_regions` and hardcoded Singapore. There was no ADR or product reason for Asia. Railway `us-west2` (Oregon) would still be a cross-coast hop to Neon Virginia.

The Node/Bun DNS default prefers IPv6. A dead AAAA to Neon costs ~1s per new TCP connect (Happy Eyeballs). Region-only without IPv4-first still showed a ~1s floor.

## Decision

- Hosted Railway services run in **`us-east4-eqdc4a`** (Virginia), next to Neon **`aws-us-east-1`**.
- Region comes from **`var.railway_regions`**, defaulting to `[{ region = "us-east4-eqdc4a", num_replicas = 1 }]`. [`infra/main.tf`](../../../infra/main.tf) passes the same value. Railway provider 0.6.1 cannot convert a variable list (or a `for` over it) into `ServiceResourceRegionModel`; `local.regions` expands `var.railway_regions[0]` into an HCL object so plan still honors the variable. The variable requires exactly one region.
- PR preview environments stay a **production copy**. They inherit the production region after `terraform apply` on merge. Do not pin preview services to a different region.
- Production cutover is `terraform apply` on merge ([`.github/workflows/deploy.yaml`](../../../.github/workflows/deploy.yaml)). That migrates the two 50GB volumes (codesearch, FalkorDB) with downtime.
- Do not move Neon to `aws-us-west-2` unless Railway also moves to `us-west2`. Do not `SET SESSION` or hold a `PoolClient` across GitHub I/O.
- The backend sets `dns.setDefaultResultOrder("ipv4first")` before opening the pg pool.
- PR scale-to-zero sends `sleepApplication: true` only. Railway rejects `numReplicas: 0` (minimum 1). Omitting a region removes it. `deploymentStop` is what stops running containers.

## Consequences

- Org SQL RTT drops from hundreds of milliseconds to a few milliseconds. Org-scoped hops should be tens of ms, not ~1s.
- Merge to `main` is the production region flip, including volume migration. Schedule that window.
- After production is US East, new PR environments inherit that location. Existing `pr-*` environments that still show Singapore stay there until they are recreated or production has flipped and they are re-duplicated.

## Alternatives considered

- **Railway `us-west2` only** — Rejected while Neon stays in Virginia; cross-coast RTT still costs hundreds of ms per org transaction.
- **Move Neon to `aws-us-west-2`** — Rejected; that is a project/branch recreate, not a Railway region flip.
- **Indexes / planner work for the 1s hops** — Rejected; PK gets and 2-row inserts were uniformly ~1050ms.
- **Pin PR previews to US East while production stays in Singapore** — Rejected; previews should remain a production copy. The production apply is the region switch.
