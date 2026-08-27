# ADR-026: Git-native connector assets

**Status:** Accepted | **Date:** 2026-08-21 | **Updated:** 2026-08-26 | **Tags:** connectors, assets, git, security, ingestion

## Context

Slack, Linear, Notion, and Confluence historically omitted provider-hosted
attachments or kept link stubs. Private and expiring links are not durable
context: agents cannot follow them later, and a context repository is not a
self-contained audit record. External media can also disappear, but fetching an
arbitrary URL from a worker introduces SSRF and credential-forwarding risk.

## Decision

1. Source connectors copy every provider-declared **file** attachment and
   explicit embedded external media item that fits the safety limits. Provider
   records whose payload is an ordinary navigation link remain hyperlinks and
   are never crawled. Linear references to GitHub pull requests and commits stay
   reference-only.
2. Assets are committed as binary git blobs under deterministic, provider-id
   keyed paths associated with their source entity. Generated Markdown links to
   successful copies are relative. Private, signed, expiring, bearer-bearing,
   and provider download URLs are never persisted.
3. Downloads are limited to **25 MiB per asset** and **100 MiB per source
   page/entity/thread**, at most **100 declared asset candidates**, and a
   **two-minute network window** per source entity. Transient requests receive
   bounded retries inside that window. Full reconciliations retain at most
   **64 MiB and 250 files of new binary payloads** before a Git write. The
   lower byte ceiling accounts for base64 expansion and simultaneous provider
   payloads in a 512 MiB worker. An unavailable, unsafe, oversized, or
   aggregate-capped asset becomes a stable provider permalink or textual stub;
   it does not fail the surrounding content write.
4. Provider credentials are sent only to explicitly trusted provider hosts and
   are stripped on cross-origin redirects. Explicit external media is HTTPS-only,
   DNS-resolved and pinned for the request, and rejects credentials, non-default
   ports, loopback, private, link-local, metadata, documentation, multicast, and
   reserved IPv4/IPv6 targets. Every redirect repeats validation.
5. Full and incremental reconciliation include asset paths. Removed or renamed
   assets are deleted within the affected entity prefix. Binary no-op detection
   compares git blob SHA values rather than decoding bytes as UTF-8.
6. Slack and Confluence workflows explicitly hand successful changed writes to
   repository ingestion, matching Linear and Notion. Provider push webhooks may
   still act as a redundant trigger.
7. Existing connector control planes remain unchanged. Confluence continues to
   use its Forge app-system-token path and frozen legacy sync tables; attachment
   reads add only the required Forge permission.
8. Repository ingestion remains single-flight per repository. A hand-off that
   overlaps a queued or running ingest persists one coalesced follow-up marker
   on the repository row. Successful and failed terminal paths both drain that
   marker against the current branch tip; tip-resolution and workflow-creation
   failures preserve it and are retried in durable workflow steps. A successful
   run clears the marker only while the row is still terminal at that run's
   ingested hash, so it cannot erase an overlap claimed after tip resolution.

## Consequences

- Context repositories contain source attachment bytes and must be treated as
  carrying the same sensitivity as the provider content.
- Git repository size, clone time, and GitHub API traffic increase. The fixed
  byte/file limits and paced binary blob writes constrain a reconciliation, but
  operators still own repository retention.
- Codesearch does not make arbitrary binary formats semantically searchable.
  Relative links preserve fidelity for repository viewers and future multimodal
  ingestion; storing bytes is not a claim that screenshots or PDFs are parsed.
- Connectors need provider-shaped asset extraction, but share one download,
  safety, budget, filename, and binary-commit boundary.
- Overlapping connector writes do not create parallel ingestion runs, but a
  failed older run can no longer strand the coalesced newer tip.

## Alternatives considered

- **Keep authenticated permalink stubs:** rejected because they expire or require
  provider access and are not durable context.
- **Copy provider-hosted assets but leave external media remote:** rejected for
  explicit embedded media; the same durability problem applies. External fetches
  therefore use the stricter SSRF boundary.
- **Mirror every hyperlink target:** rejected because links are not attachment
  declarations and doing so would crawl the web.
- **Persist a queue or “latest pending hash” per repository:** rejected because
  Git commit hashes are identities, not an ordering, and a force-push can make
  the last observed hash stale. The durable boolean marker records that work
  overlapped; the drain re-resolves the branch source of truth and keys workflow
  creation to that resolved tip.
- **Store assets outside git:** rejected because it creates a second durability,
  access-control, and audit store.
