# ADR-030: Co-locate Production Railway and Neon in Singapore

**Status:** Accepted | **Date:** 2026-09-04 | **Tags:** infrastructure, railway, neon, postgres, reliability

## Context

The production backend, OpenWorkflow worker, and codesearch service run on
Railway in `asia-southeast1-eqsg3a` (Singapore), while the production Neon
project runs in `aws-us-east-1`. The root Terraform configuration also declared
Railway US East even though the module ignored that input and hard-coded
Singapore.

Production logs contain intermittent PostgreSQL timeouts and terminated
connections affecting Better Auth, webhooks, and `ctx_advisor`. The logs do not
prove that geographic distance caused every disconnect, but a Singapore-to-US
East database path adds avoidable latency and another long-haul network failure
surface to every query.

Changing a live database region is not an in-place operation. Neon requires a
new project, and a simple dump/restore would impose an unnecessarily long write
outage.

## Decision

Singapore is the canonical production region:

- Railway app services use `asia-southeast1-eqsg3a`.
- A PostgreSQL 17 Neon project is provisioned in `aws-ap-southeast-1` with the
  same database, role, retention, maintenance, and compute settings as the
  source project.
- The existing US East project remains the active database until a controlled
  cutover. Provisioning the target must not change `DATABASE_URL`.
- Data moves with native PostgreSQL logical replication over direct Neon
  connections. Application traffic continues to use the pooled target
  connection.
- Enabling logical replication on the source is an explicit, irreversible gate
  because Neon suspends active endpoints while changing `wal_level`.
- Before cutover, all Railway services that can write PostgreSQL (`backend`,
  `openworkflow`, and `codesearch`) are scaled to zero. The operator waits for
  replication lag to reach zero, synchronises sequences, switches the database
  target and migration secret, then restores the services.
- Terraform consumes `railway_regions` instead of maintaining a hidden region
  constant. The database target and source logical-replication state are
  explicit Terraform inputs supplied by protected GitHub Actions variables.
- The US East project is retained through a validation window. It is not a safe
  rollback target after Singapore accepts writes unless changes are reconciled
  or reverse replication is established.

## Consequences

- The migration has near-zero read downtime but a short, deliberate write
  outage. Claiming zero downtime would be false because replication is
  one-way and service deployments are not atomic.
- DDL, sequences, large objects, and tables without suitable replica identity
  require explicit preflight checks; logical replication does not solve them.
- Both Neon projects incur cost during replication and the validation window.
- Normal query latency and exposure to long-haul connection failures should
  fall after cutover, but application-level transient handling remains
  necessary.
- The target can be provisioned and reviewed independently of the irreversible
  source change and traffic switch.

## Alternatives Considered

- **Move Railway to US East:** Rejected. Singapore is the chosen canonical
  application region.
- **Dump and restore during a maintenance window:** Rejected because it extends
  write downtime with database size.
- **Application dual writes:** Rejected because it adds consistency machinery
  and failure modes for a one-off migration.
- **Increase global SQL retries:** Rejected for writes. A lost acknowledgement
  after commit is ambiguous and automatic replay can duplicate mutations.
