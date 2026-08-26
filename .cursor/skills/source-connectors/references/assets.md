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

Done means tests cover: authenticated download, cross-origin credential
stripping, external SSRF rejection, both byte limits, deterministic safe paths,
relative Markdown, fallback stubs, unchanged blobs, and stale-asset deletion.
Run `pnpm --filter @ctxpipe/backend verify-connector-assets-runtime` before a
Railway acceptance test; it exercises the Bun TLS pinning path, authenticated
download, and cross-host redirect credential stripping. It requires the repo's
declared Bun 1.3.11+ runtime; older Bun versions do not honour the HTTPS lookup
contract safely. When the host Bun is older, run the deploy-runtime gate
directly:

```bash
docker run --rm -v "$PWD:/workspace" -w /workspace/apps/backend \
  oven/bun:1.3.11-alpine bun run src/scripts/verifyConnectorAssetRuntime.ts
```

Document that copied binaries inherit provider-content sensitivity and are not
automatically semantically searchable.
