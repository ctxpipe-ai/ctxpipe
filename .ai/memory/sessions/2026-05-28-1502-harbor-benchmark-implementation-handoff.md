# Session: 2026-05-28 15:02 (+07) — Harbor benchmark implementation handoff

## Summary

Completed grill-with-docs design for the Harbor benchmark and locked all major v1 decisions. The benchmark compares baseline (primary repo only, no MCP) versus ctxpipe (hosted MCP with no sibling local clones) to test org-context advantage. Task shape and deterministic oracle were finalized around BoxyHQ starter-kit + Polis cross-repo SSO configuration facts. Next session should move directly to implementation in `benchmarks/` and CI wiring.

## Work Completed

- Locked hypothesis: org-context advantage (not “MCP replaces all local clones”).
- Locked fixture: primary `boxyhq/saas-starter-kit`; siblings `ory/polis`, `boxyhq/ui`; pin SHAs via lockfile.
- Locked runtime model: hosted out-of-band ctxpipe endpoint via `CTXPIPE_MCP_URL`; `CTXPIPE_API_TOKEN` required.
- Locked manual precondition: operator pre-ingests benchmark org at pinned SHAs in hosted env before scored runs.
- Locked task shape A (env bridge) with strict `answer.json` oracle fields.
- Locked harness: smoke with `harbor run -a oracle`; scored runs with `harbor run -a cursor-cli`.
- Locked no synthetic org ADRs for v1.

## Decisions Made

- No new ADR created in this session (design lock only).
- v1 excludes synthetic org docs in ctxpipe and relies on ingested repos only.

## Context for Next Session

- Start implementation under `benchmarks/`:
  - fixture lockfile (`benchmarks/fixtures/boxyhq-saas-v1.lock.json`)
  - Harbor task scaffold for env-bridge question
  - two run configs (baseline vs ctxpipe MCP)
  - verifier/oracle wiring and README runbook
  - GitHub Actions workflow (oracle smoke by default; scored run path with secrets)
- Keep scored runs pointed to hosted benchmark ctxpipe; do not add compose-in-task for v1.
- Ensure ctxpipe arm requires both `CTXPIPE_MCP_URL` and `CTXPIPE_API_TOKEN`.

## Open Questions

- Should scored runs execute on every PR or as manual/scheduled workflow only (cost + secret exposure trade-off)?
- Confirm exact benchmark org slug and secret names for CI.

---
*Session duration: ~2h+ (design grill and lock)*
