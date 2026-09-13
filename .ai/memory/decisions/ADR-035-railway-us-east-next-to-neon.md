# ADR-035: Railway compute in US East next to Neon

**Status:** Accepted | **Date:** 2026-09-13 | **Tags:** infra, railway, neon, latency

## Context

Hosted product SQL uses Neon’s transaction-mode pooler in `aws-us-east-1`. Every org query is a short `BEGIN` + `SET LOCAL app.organization_id` + work + `COMMIT` ([ADR-027](ADR-027-short-org-sql-unique-sandbox-rows.md), [ADR-028](ADR-028-postgres-rls-app-role.md)). Railway production and every `pr-*` environment duplicated from it ran in `asia-southeast1-eqsg3a` (Singapore). That ~200ms RTT made each hop ~1s.

[`infra/main.tf`](../../../infra/main.tf) already passed `railway_regions = [{ region = "us-east4-eqdc4a", num_replicas = 1 }]`. The module ignored the variable and hardcoded Singapore. There was no ADR or product reason for Asia. Railway `us-west2` (Oregon) would still be a cross-coast hop to Neon Virginia.

## Decision

- Hosted Railway services run in **`us-east4-eqdc4a`** (Virginia), next to Neon **`aws-us-east-1`**.
- Terraform `local.regions` is `var.railway_regions`. Do not hardcode a Railway region in the module.
- PR previews pin **stateless** services (backend, worker, UI) to US East after `duplicate production`. Codesearch and FalkorDB stay on the inherited region in previews so Railway does not migrate their volumes for an experiment.
- Production cutover is `terraform apply` on merge ([`.github/workflows/deploy.yaml`](../../../.github/workflows/deploy.yaml)). That migrates the two 50GB volumes (codesearch, FalkorDB) with downtime. Do not merge until a US-East preview has shown org SQL hops in tens of milliseconds.
- Do not move Neon to `aws-us-west-2` unless Railway also moves to `us-west2`. Do not `SET SESSION` or hold a `PoolClient` across sandbox/GitHub I/O.
- The Node/Bun DNS default prefers IPv6. A dead AAAA to Neon costs ~1s per new TCP connect (Happy Eyeballs). The backend sets `dns.setDefaultResultOrder("ipv4first")` before opening the pg pool. Org-tx logs (`db.org_tx`, `db.pool.connect`) split connect/BEGIN/COMMIT from `set_config` and the handler so a 1s floor is attributable.

## Consequences

- Org SQL RTT drops from hundreds of milliseconds to a few milliseconds. Chat `sandbox-lifecycle` store/lock marks should be tens of ms, not ~1s. OpenCode serve time is unchanged.
- Merge to `main` is the production region flip, including volume migration. Schedule that window.
- PR scale-to-zero must zero both Singapore and US East so leftover replica config cannot keep a preview awake.

## Alternatives considered

- **Railway `us-west2` only** — Rejected while Neon stays in Virginia; cross-coast RTT still costs hundreds of ms per org transaction.
- **Move Neon to `aws-us-west-2`** — Rejected; that is a project/branch recreate, not a Railway region flip.
- **Indexes / planner work for the 1s hops** — Rejected; PK gets and 2-row inserts were uniformly ~1050ms.
