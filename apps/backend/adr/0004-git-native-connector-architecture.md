# ADR-0004: Git-Native Connector Architecture

## Status

Accepted

## Date

2026-03-16

## Context

The original connector design had each connector managing its own GitHub repository. This created friction: users had to create a separate repo per connector type (Confluence, Jira, Notion, etc.), and there was no unified view of what was being synced.

Additionally, the sync model was binary — either a PR or a direct commit — with no distinction between _configuration changes_ (what to sync) and _content changes_ (the actual synced documents). This made the system hard to audit and reason about.

We also lacked a way for users to select which spaces and pages to include, beyond typing in raw space keys.

## Decision

### 1. Single shared repository per organisation

All connector types (Confluence, Jira, Notion, Linear) within an organisation point to the **same GitHub repository**. Each connector type owns a dedicated subdirectory:

```
/ confluence/
    config.yaml
    RAD/
      getting-started.md
  /jira/
    config.yaml
  /notion/
    config.yaml
```

Enforcement: on connector create/update, the backend validates that `githubRepoName` is consistent across all connectors in the org.

### 2. `config.yaml` as the scope definition

Each connector directory contains a `config.yaml` that declares the ingestion scope. Example for Confluence:

```yaml
version: 1
type: confluence
baseUrl: https://your-domain.atlassian.net
spaces:
  - key: RAD
    name: R&D
  - key: DEV
    name: Development
    pages:           # absent = all pages in space; present = only these IDs
      - "12345"
      - "67890"
```

This file is the source of truth for what is ingested. Storing it in git gives a complete audit trail of scope changes.

### 3. Two-tier sync mechanism

| Trigger | Mechanism | Result |
|---------|-----------|--------|
| Scope change (spaces/pages) | `POST /:id/scope` | Config PR on GitHub with updated `config.yaml` |
| Content sync (fetch latest pages) | `POST /:id/sync` | Direct commit to `main` — no PR |

**Config sync** is intentionally gated behind a PR so changes to ingestion scope are reviewed by a human before taking effect.

**Content sync** commits directly to `main` without a PR — these are incremental document updates, not schema changes, and auto-merging keeps them low-friction.

### 4. `selectedPageIds` per space in the database

The `connector_spaces` table gains a `selected_page_ids jsonb` column:
- `null` = sync all pages in the space
- `string[]` = sync only the listed Confluence page IDs

This mirrors the YAML representation and drives filtering in the content sync.

### 5. Tree UI for scope selection

A `SpacePageTree` component (using React Aria) lets users:
- Browse and select/deselect entire spaces
- Expand spaces to select individual pages (lazy-loaded on expand)
- Click "Save Scope" to persist and trigger a config PR

The edit modal gains a **Credentials** tab (existing fields) and a **Scope** tab (the tree).

## Consequences

**Positive:**
- Single repo per org simplifies GitHub permission management — one token, one webhook, one repo to monitor.
- `config.yaml` in git gives full audit history of scope changes.
- The PR gate on config changes prevents accidental ingestion of sensitive spaces.
- Clear separation of concerns: scope changes → PR, content changes → direct commit.
- Tree UI removes the friction of manually typing space keys.

**Negative / trade-offs:**
- All connectors must share one `githubRepoName`. If users want isolation between connector types, they cannot achieve it within a single org — this is a deliberate constraint.
- Initial setup requires a PR to be merged before the first content sync can succeed (since `config.yaml` must exist). This adds one extra step.
- GitHub webhooks (auto-triggering content sync when a config PR is merged) are **out of scope** for this build. Until implemented, users must trigger content sync manually after merging a config PR.

## Out of Scope (deferred)

- GitHub webhooks to auto-trigger content sync on PR merge
- Bidirectional sync (editing `config.yaml` on GitHub updating the UI state)
- Jira, Notion, Linear connector implementations (Confluence only for now)
- Auto-merge of content PRs via the GitHub API
