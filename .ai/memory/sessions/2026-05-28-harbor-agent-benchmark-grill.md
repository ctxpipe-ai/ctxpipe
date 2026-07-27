# Session: 2026-05-28 — Harbor agent benchmark (grill-with-docs)

## Summary

Grill-with-docs session to design a Harbor-based, repeatable agent benchmark (local + GitHub Actions) with two arms: baseline (local primary repo, no ctxpipe MCP) vs ctxpipe MCP (no sibling clones, pre-ingested org). Primary hypothesis is **org-context advantage** for SaaS builders who do not have the whole org checked out—not “MCP replaces all local code reading.” Fixture evolved from CodeScaleBench/better-auth to a **public snapshot**: primary `boxyhq/saas-starter-kit`, siblings `ory/polis` + `boxyhq/ui` (Polis is the real SSO engine; starter-kit is the product app). Deliverable v1 is structured `answer.json` with deterministic oracle. **Locked Q7:** out-of-band hosted ctxpipe; `CTXPIPE_MCP_URL` + required `CTXPIPE_API_TOKEN`; manual pre-ingest on benchmark org before runs; GHA uses dedicated hosted org (not compose-in-task for v1). **Grill complete.** Implementation remaining: `benchmarks/` layout, lockfile, Harbor task, GHA.

## Work Completed

- Locked benchmark hypothesis (Option B: org-context advantage) and baseline arm (primary repo only on disk).
- Locked deliverable type (structured answer / oracle, not LLM judge for v1).
- Evaluated fixture sources: rejected better-auth (memorization + dogfooding); considered hatchet/permitio/knock; chose BoxyHQ ecosystem for B2B SaaS narrative.
- Clarified `saas-starter-kit` is boilerplate app logic; core SSO service is `ory/polis` (formerly BoxyHQ Jackson).
- Locked fixture shape A: primary `saas-starter-kit`, ingest `ory/polis` + `boxyhq/ui`.
- Documented Apache-2.0 / MIT licensing for CSB (informational); pivot away from CSB tasks.
- Updated `.ai/memory/glossary.md` with benchmark terms and BoxyHQ fixture definition.
- **Q7 locked:** hosted benchmark ctxpipe; parameterized MCP URL; `CTXPIPE_API_TOKEN` required; manual fixture ingest before benchmark runs.
- **Q8–9 locked:** env-bridge task; oracle fields `jackson_url_env`, `jackson_external_url_env`, `jackson_api_key_env`, `polis_saml_path_prefix`, `polis_saml_path_source_file` (strict match at lockfile SHAs).
- **Q10 locked:** smoke = Harbor `oracle`; scored default = Harbor `cursor-cli` (not terminus for v1).
- **Q11 locked:** no synthetic org ADRs in hosted benchmark org for v1.

## Decisions Made

- **Q7 — ctxpipe runtime:** Out-of-band hosted instance for scored CI; Harbor task configures `CTXPIPE_MCP_URL` (override for local). `CTXPIPE_API_TOKEN` required (MCP is protected). Pre-ingested org at lockfile SHAs: operator sets up manually on hosted env before `harbor run`. Compose-in-task deferred.

- No new ADR yet—design grill only. Consider ADR when Harbor harness + ingest topology is implemented (hard to reverse).

## Context for Next Session

- Continue **grill-with-docs**: next up **Harbor agent harness** for v1.
- Then: first task instruction + oracle, `benchmarks/fixtures/boxyhq-saas-v1.lock.json` (pinned SHAs), Harbor task path, CI workflow sketch.
- Skills: `.agents/skills/create-task/SKILL.md`, `.agents/skills/rewardkit/SKILL.md`; inspiration [CodeScaleBench](https://github.com/sourcegraph/CodeScaleBench) (2-config matrix, artifact verification)—not vendoring CSB tasks.
- ctxpipe MCP entrypoint: `ctx_advisor` + repo tools after ingest (`apps/backend/src/mcp/tools.ts`).

## Open Questions

- Exact v1 benchmark question and oracle fields (cross-repo SSO / Polis integration from starter-kit perspective)?
- Optional synthetic org ADRs in ctxpipe (not in git) to separate memorization from org memory?
- Which Harbor agent harness for v1 (oracle, terminus, Claude Code)?

---
*Session: grill-with-docs, no implementation started*
