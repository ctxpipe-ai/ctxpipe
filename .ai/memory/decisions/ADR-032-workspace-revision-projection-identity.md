# ADR-032: Workspace revision and projection identity

**Status:** Accepted | **Date:** 2026-09-08 | **Tags:** workspace, git, postgres, recovery

## Context

Recovery Gate 2 requires one immutable revision policy and one projection model. The existing active URL/SHA pair cannot identify the generation, connection, or default branch that produced the visible content. A queued hydrate also previously substituted the current generation for its queued identity.

## Decision

`WorkspaceRevision` carries the workspace, generation, credential-free remote and connection identity, resolved default branch, immutable SHA, and access purpose. Resolve it at the database/product-policy boundary. The canonical remote uses provider-neutral `connectionId`; existing `github_connection_id` columns are database mappings. Credentials remain transient and are never part of the revision or workflow input. Native Git resolves branch metadata and reads the immutable tree for every provider.

Persist the complete active revision in the same PostgreSQL transaction that replaces knowledge units and linked membership. Desired generation, URL, SHA, and connection must still match before activation. A remote URL or connection change advances the desired generation. A same-SHA relink is a new revision; it cannot reuse an old generation's completion marker.

Expose a discriminated `ProjectionState` from the model boundary. A building or failed replacement retains its previous published projection. Embedding and search freshness describe derived results; they never replace the PostgreSQL authority. Readers that need metadata, units, or membership together consume a single database snapshot.

Codesearch artifacts use immutable `ws:<workspaceId>:<sha>` checkout keys. A replacement index is built beside the published checkout; its checkout row and files cannot advance the published revision in place. Backend-signed codesearch claims bind repository ids to immutable SHAs, and index admission rejects a contradictory target. Search, SCIP, and structural readers use the captured published membership and revision. The legacy `ws:<workspaceId>` key requires a signed `legacyWorkspace` claim and is read-only during migration. A workspace token with neither immutable claims nor that explicit legacy discriminator is rejected.

Existing columns are temporary migration mappings, owned by the database model. Historical active URL/SHA values do not prove a generation, connection, or branch. Represent those explicitly as legacy projections until successful rehydration; never label them with the current desired identity. Gate 6 removes superseded mappings after upgrade proof.

Linked work carries `LinkedRevision`: the complete owner revision, link id, repository id, remote/connection, selected ref, and immutable SHA. The tip resolver captures these in one PostgreSQL statement and compares them before persistence. Index admission and publication check the same value. GitHub push handlers queue the common durable tip resolver; webhook fields cannot directly publish desired metadata.

## Consequences

- Queued work carries immutable identity, and activation, failure, and derived writes fence that identity.
- Relinking preserves the previous projection without silently rebinding it to a new connection.
- Repository reads use scoped read credentials and a credential-free native Git origin.
- Schema migrations add the missing identity rather than guessing historical metadata. Transitional DTOs may preserve existing wire fields while callers move to the model value.
