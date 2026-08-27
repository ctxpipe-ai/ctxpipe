# Connector assets

Use this reference whenever a connector reads images, files, attachments, media
blocks, or external embeds. [ADR-026](../../../../.ai/memory/decisions/ADR-026-git-native-connector-assets.md)
is the decision source of truth.

## Classify

- **Attachment:** a provider-declared file record or explicit embedded media
  node. Copy it.
- **Ordinary link:** user-authored navigation to another resource. Keep it as a
  link; never crawl it.
- **GitHub reference through Linear:** pull request or commit metadata. Keep it
  reference-only so the GitHub connector remains the provenance owner.

## Download boundary

Use the shared connector asset service. Provider credentials go only to named
provider hosts and are removed before a cross-origin redirect. External assets
must be HTTPS, DNS-pinned to validated public addresses, and revalidated after
every redirect.

Limits are committed product policy, not environment variables:

- 25 MiB per asset
- 100 MiB per source page, entity, or captured thread
- 100 declared asset candidates per source entity
- two minutes of network work per source entity, including bounded retries
- 64 MiB and 250 retained new binary files per full reconciliation; this
  accounts for base64 expansion and provider buffers in a 512 MiB worker

An unsafe, unavailable, or oversized asset produces a stable source permalink or
textual stub. Continue the content write.

## Git shape

- Key paths with provider ids or stable source-node keys; sanitised names are for
  readability, not identity.
- Put assets beside their owning content when its layout has a directory.
  Flat-file connectors may use a sibling `<stem>/assets/` directory.
- Write bytes through `commitFiles` with `encoding: "base64"`.
- Rewrite successful Markdown references to relative paths. Never write private,
  signed, expiring, bearer-bearing, or provider download URLs.
- Include assets in full and incremental desired-path sets. Prune stale files
  only inside the affected entity prefix.
- Compare binary git blob SHA values for no-op detection; never decode binary
  content as UTF-8.

## Review gate

Run `pnpm --filter @ctxpipe/backend test:connector-assets`. The gate discovers
the standard connector `assets`, `client`, `converter`, `incremental`,
`markdown-images`, `page-tree`, and `sync` test modules, plus Git writes and
ingestion hand-offs. It also runs connector route/model lifecycle tests,
repository single-flight tests, provider webhook ingress, and generated
integration-manifest tests so event subscription and routing cannot drift away
from reconciliation. New connectors should use those module names and add their
route, model, and webhook seams to `vitest.connector-assets.config.ts`.

Keep shared boundary cases in `services/connectors/assets.test.ts`: authenticated
download, cross-origin credential stripping, redirect and DNS SSRF rejection,
byte/time limits, canonical URL identity, and safe paths. Each provider suite
must then prove its own lifecycle: new binary, unchanged binary no-op, changed
binary replacement, transient download failure preserving the attached durable
binary, true removal pruning it, relative Markdown, safe fallback, ordinary
links not being crawled, provider labels escaped, and no private or signed URL
persisted. At least one test must cross the connector's public sync seam from
mocked provider payloads through asset capture to the asserted Git write; helper
tests alone do not prove orchestration. Connectors with overlapping selectable
roots must assign each provider identity one canonical owner and prove that full
and incremental reconciliation neither writes a second location nor consumes
the asset budget twice. Every full and incremental connector
workflow must also prove that both a changed write and a successful Git no-op
invoke the shared tip-aware helper, so a replay can recover an uncheckpointed
write without regressing an already-ingested newer tip. Workflows that load a
mutable repository binding must also simulate a replay after rebinding and prove
that the checkpointed write target is the one handed to ingestion. The shared
ingestion suite must prove that an overlapping hand-off is retained when the
active run fails, and that tip-resolution or follow-up creation failure leaves a
retryable coalesced request rather than silently clearing it. It must also prove
that a terminal run clears only its own settled marker, and carries the
checkpointed branch plus the hand-off's resolved GitHub connection into failure
recovery.

Run `pnpm --filter @ctxpipe/backend verify-connector-assets-runtime` before a
Railway acceptance test; it exercises the Bun TLS pinning path, authenticated
download, and cross-host redirect credential stripping. It requires the repo's
declared Bun 1.3.11+ runtime; older Bun versions do not honour the HTTPS lookup
contract safely. When the host Bun is older, run the deploy-runtime gate
directly:

```bash
docker run --rm \
  -e DATABASE_URL=postgresql://runtime-verifier.invalid/ctxpipe \
  -e AUTH_SECRET=connector-assets-runtime-verifier-secret \
  -v "$PWD:/workspace" -w /workspace/apps/backend \
  oven/bun:1.3.11-alpine bun run src/scripts/verifyConnectorAssetRuntime.ts
```

Use only dedicated provider tenants and throwaway repositories for preview
acceptance. A Neon preview branches production data, so the PR deployment must
also use a preview-specific OpenWorkflow namespace before its worker starts.

Document that copied binaries inherit provider-content sensitivity and are not
automatically semantically searchable.
