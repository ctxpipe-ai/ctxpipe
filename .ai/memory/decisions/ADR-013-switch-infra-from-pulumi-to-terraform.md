# ADR-013: Terraform as our IAC

**Status:** Accepted | **Date:** 2026-03-17 | **Tags:** infra, pulumi, terraform, railway, neon

## Context

We experimented with Pulumi as our IAC which had great DX and supports all Terraform providers. However, our goal is to make it very easy for consumers to self-host whether it is on Railway, AWS, GCP and Azure - it should also fit into their existings setup. Due to this reason, we picked Terraform instead as this is the industry standard. For customers using Pulumi, they can use our Terraform modules seamlessly.

## Decision

Define the Railway + Neon production infrastructure in Terraform under a new root `infra/` directory, using a reusable Terraform module in `infra/module/ctxpipe/`.

## Rationale

- **Ecosystem & tooling**: Terraform has broader ecosystem support (modules, tooling, CI patterns) and matches how we want to manage infra going forward.
- **Reusability**: A dedicated module (`infra/module/ctxpipe/`) allows reuse by other stacks/environments while keeping prod wiring in `infra/main.tf`.
- **Clarity of ownership**: Placing infra at repo root (`infra/`) makes it more discoverable and separates infra concerns from application code in `apps/*`.

## Consequences

- **State management**: Terraform state will be stored in a remote backend (Cloudflare R2 via the S3 backend), which needs to be configured and secured separately.

## Alternatives Considered

- **Stay on Pulumi**: Rejected because it limits interoperability with existing Terraform tooling and modules, and we prefer Terraform as our standard infra IaC layer.
- **Hybrid: Pulumi + Terraform**: Rejected for core infra to avoid split-brain definitions; we instead use Terraform as the single source of truth for Railway/Neon while leaving Pulumi only as a temporary reference during migration.

