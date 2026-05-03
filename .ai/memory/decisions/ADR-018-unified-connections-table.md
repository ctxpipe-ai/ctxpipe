# ADR-018: Unified `connections` table

**Status:** Accepted | **Date:** 2026-04-22 | **Tags:** database, connectors, github, forge, confluence, multi-tenant

## Context

GitHub App installations and Atlassian Forge / Confluence installations were stored in separate tables (`github_installations`, `forge_installations`) with product logic that often assumed **at most one row per organisation per integration**. We need **multiple connections per org per type** (e.g. several GitHub installs or several Confluence sites) and a single place to reason about connector identity and configuration.

## Decision

1. **One table:** `connections` with `id` prefixed `con_` (via `generateObjectId("con")`), `org_id`, `type` (`github` | `forge`), `config` (jsonb — type-specific fields; **secrets stay in config** and are never returned on list endpoints), and timestamps. Indexes on `(org_id)` and `(org_id, type)` for listing. **No** global `UNIQUE (org_id, type)`; add targeted uniqueness in `config` or partial indexes when a specific invariant is required.

2. **Dependents:** Repository rows reference the GitHub connection via **`github_connection_id`** → `connections.id`. Confluence **`confluence_spaces`** and **`confluence_sync_targets`** reference **`connection_id`** → `connections.id`. **Sync targets** are **unique per `connection_id`** and store **`repository_id`** (FK to `repositories`), not a free-text repository name.

3. **Migrations:** Prefer a **two-step** Drizzle workflow when evolving from legacy tables: (1) add `connections`, backfill with deterministic id mapping (`con_` + same suffix as former `ghi_` / `fgi_` ids where applicable), rewire child FKs, optionally leave legacy tables until code is deployed; (2) remove legacy tables from the Drizzle schema and **`pnpm run db:generate`** so drops are generated, not hand-written. Custom SQL in migration 1 is limited to **data movement** and FK cleanup Drizzle cannot express.

4. **APIs:** **`GET /:orgSlug/api/v1/connectors`** returns **metadata only**: `id`, `type`, `createdAt`, `updatedAt` (no `config`). Atlassian routes accept optional **`connectionId`** query (or disambiguate via data already scoped to a connection) so multiple Forge connections per org are safe.

5. **Application disambiguation:** Avoid helpers that return a single connector row for an org without a rule. Prefer **`connectionId`**, **list-by-org**, or **resolve via `repository_id`** (repo row points at the GitHub connection). OpenWorkflow inputs may still use the field name `forgeInstallationId` in places; that value is the **`connections.id`** for Forge.

## Consequences

- Connectors UI lists **N** cards from the list API; wizards and modals must carry **`connectionId`** when more than one connection of a type exists.
- Call sites must be audited when adding new org-level connector behavior so they do not pick `.limit(1)` arbitrarily.
- **List and logs:** Never log or return full `config` on list or debug paths where secrets could leak.

## Alternatives considered

- **Keep separate tables only** — Rejected; duplicates cross-cutting concerns and makes “all connectors” UX harder.
- **Enforce one row per org per type in DB** — Rejected; product requires multiple GitHub and/or Forge connections per org.
