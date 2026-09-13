# ADR-029: Railway compute in US East next to Neon

**Status:** Accepted | **Date:** 2026-09-13 | **Tags:** infra, railway, neon, latency

## Context

Hosted product SQL uses Neon’s transaction-mode pooler in `aws-us-east-1`. Every org query is a short `BEGIN` + `SET LOCAL app.organization_id` + work + `COMMIT`. Railway production and every `pr-*` environment duplicated from it ran in `asia-southeast1-eqsg3a` (Singapore). That ~200ms RTT made each hop ~1s.

[`infra/main.tf`](../../../infra/main.tf) already passed `railway_regions = [{ region = "us-east4-eqdc4a", num_replicas = 1 }]`. The module ignored the variable and hardcoded Singapore. There was no ADR or product reason for Asia. Railway `us-west2` (Oregon) would still be a cross-coast hop to Neon Virginia.

The Node/Bun DNS default prefers IPv6. A dead AAAA to Neon costs ~1s per new TCP connect (Happy Eyeballs). Region-only without IPv4-first still showed a ~1s floor.

## Decision

- Hosted Railway services run in **`us-east4-eqdc4a`** (Virginia), next to Neon **`aws-us-east-1`**.
- Terraform `local.regions` is `var.railway_regions`. Do not hardcode a Railway region in the module.
- PR previews pin **stateless** services (backend, worker, UI) to US East after `duplicate production`. Codesearch and FalkorDB stay on the inherited region in previews so Railway does not migrate their volumes for an experiment.
- Production cutover is `terraform apply` on merge ([`.github/workflows/deploy.yaml`](../../../.github/workflows/deploy.yaml)). That migrates the two 50GB volumes (codesearch, FalkorDB) with downtime. Do not merge until a US-East preview has shown org SQL hops in tens of milliseconds.
- Do not move Neon to `aws-us-west-2` unless Railway also moves to `us-west2`. Do not `SET SESSION` or hold a `PoolClient` across GitHub I/O.
- The backend sets `dns.setDefaultResultOrder("ipv4first")` before opening the pg pool. Org-tx logs (`db.org_tx`, `db.pool.connect`) split connect/BEGIN/COMMIT from `set_config` and the handler so a 1s floor is attributable.
- PR scale-to-zero sends `sleepApplication: true` only. Railway rejects `numReplicas: 0` (minimum 1). Omitting a region removes it. `deploymentStop` is what stops running containers.

## Consequences

- Org SQL RTT drops from hundreds of milliseconds to a few milliseconds. Org-scoped hops should be tens of ms, not ~1s.
- Merge to `main` is the production region flip, including volume migration. Schedule that window.
- PR pin GraphQL must send only `us-east4-eqdc4a` at 1 replica. A `Too small: expected number to be >= 1` error means the helper is wrong — fix it, do not ignore the warning.

## Alternatives considered

- **Railway `us-west2` only** — Rejected while Neon stays in Virginia; cross-coast RTT still costs hundreds of ms per org transaction.
- **Move Neon to `aws-us-west-2`** — Rejected; that is a project/branch recreate, not a Railway region flip.
- **Indexes / planner work for the 1s hops** — Rejected; PK gets and 2-row inserts were uniformly ~1050ms.
