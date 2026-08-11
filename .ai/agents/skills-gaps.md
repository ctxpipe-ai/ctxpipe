# Agent skills gaps

Short note from the 2026-08-11 find-missing-skills pass. Do not invent placeholder skills for these.

## Searches attempted

| Query | Method | Notable hits |
| --- | --- | --- |
| `qa` | `npx skills find qa -y`, `npx skills add mattpocock/skills -l`, clone of `mattpocock/skills`, skills.sh | skills.sh still lists `mattpocock/skills@qa` (~200K installs historically), but **current repo has no `qa` skill** (35 skills; deprecated bucket empty). `npx skills add mattpocock/skills --skill qa` cannot install it. Community hits (`daymade/...@qa-expert`, `browser-use/...@qa`, etc.) are unrelated testing/browser workflows — not Matt’s issue-tracker QA session. |
| `aws-cdk` | `npx skills find aws-cdk -y`, skills.sh | **Installed** `aws/agent-toolkit-for-aws@aws-cdk` (official AWS toolkit, Gen/Socket clean). |
| `changeset` | `npx skills find changeset -y` | Only low-adoption / repo-specific skills (`oakoss/agent-skills@changesets` ~100 installs, Saleor/Astro/Clerk monorepo helpers). No Changesets-org or widely trusted general skill. |
| `railway` | `npx skills find railway -y` | **Installed** `railwayapp/railway-skills@use-railway` (official). |
| `logging` / `observability` | `npx skills find … -y` | Generic Azure/Google/Elastic skills; not a fit. Repo already has `analyze-logs` + `review-logging-patterns` (evlog). |

## Remaining gaps (not installed)

1. **`qa` (Matt Pocock)** — Referenced by the local copy of `setup-matt-pocock-skills`, but absent from today’s `mattpocock/skills` tree. Upstream setup skill text no longer mentions `qa`. Revisit when Matt ships it again (or when skills.sh listing matches git).
2. **Changesets / package-release skill** — No reputable standalone skill found. Package release guidance stays in root `AGENTS.md` (`pnpm changeset`, version PR workflow).
3. **Pulumi** — Intentionally not installed (product uses `@ctxpipe/aws-cdk`; ghost lock entries removed).

## Intentionally skipped

- ConKeeper / memory skills — already on disk; do not reinstall.
- Community “qa-expert” / Playwright QA packs — wrong workflow for this repo’s issue-tracker setup.
- Extra Railway skills beyond `use-railway` — entrypoint skill covers routing to CLI/MCP; more granular Railway skills optional later.
