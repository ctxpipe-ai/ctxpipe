# ADR-046: Workspace revision and projection identity

**Status:** Accepted (revised 2026-10-02) | **Date:** 2026-09-08 | **Tags:** workspace, git, postgres

## Context

What "current" meant for a Workspace was spread over loosely coupled fields (desired URL/generation/SHA, active URL/SHA, indexed SHA, hydrate status). Callers reconstructed it differently, and a queued hydrate could activate content under the wrong generation.

## Decision

- **`WorkspaceRevision`** is the one immutable identity of Workspace content: workspace id, generation, credential-free remote (URL + connection), default branch, commit SHA, and access purpose (`read` / `publish-session` / `write-default`). It is resolved at the model boundary; credentials are never part of it or of workflow input.
- **`LinkedRevision`** is the same for a linked repository: owner revision, link id, repository id, remote, ref and SHA.
- **`ProjectionState`** (`absent` / `building` / `active` / `failed`, plus `legacy` for pre-upgrade data) is the only way readers learn what is served. A building or failed replacement keeps the previous projection serving.
- **Activation** replaces knowledge units and linked membership and records the active revision in one Postgres transaction, guarded by a compare-and-set on generation, URL, connection and SHA. Relinking advances the generation; a same-SHA relink is still a new revision.
- **Derived stores** (graph, embeddings, codesearch) are keyed by the revision and report their own freshness. Failure leaves Postgres serving; they retry from Postgres without refetching git. Missing graph data is "unavailable", never an empty graph.
- **Codesearch** indexes immutable checkouts (`ws:<workspaceId>:<sha>`); a replacement index is built beside the published one and only the publish step switches it. Backend-signed claims bind repositories to SHAs.
- Hot paths compare stored SHAs only; git remotes are contacted by webhooks (as triggers), our pushes, hydrate/index jobs, and a periodic tip check.

## Consequences

- Queued work carries its revision and is fenced by it at activation, so late or stale work cannot publish.
- Old workflow inputs without a complete revision are rejected and re-enqueued by the tip check.
- Pre-upgrade active data is labelled `legacy` until the first successful hydrate; it is never relabelled with the current desired identity.
