## Where agent instructions live

This file holds repo-wide rules. In an app or package, also read that folder's `AGENTS.md` if it exists.

- **apps/backend**: [apps/backend/AGENTS.md](apps/backend/AGENTS.md) — API, OpenAPI, MCP, Drizzle, TypeScript, etc. **[Source-connectors skill](.agents/skills/source-connectors/)** when designing, building, or reviewing a source connector (Linear, Notion, Slack, git-native mirror/capture, `connections.config`, self-host), when provider requests can multiply per related record, or when a full import must resume after a crash.
- **apps/otel-collector**: laptop OTLP debug sink for `pnpm dev:infra` (stdout only). Hosted ingest is [`ops/observability`](ops/observability/) ([ADR-038](.ai/memory/decisions/ADR-038-self-hosted-clickstack-langfuse.md)).
- **apps/codesearch**: [apps/codesearch/AGENTS.md](apps/codesearch/AGENTS.md) — Zoekt/SCIP orchestration, read-only DB, OpenAPI + Zod, and the manual Kubernetes ingest memory gate.
- **apps/ui**: [apps/ui/AGENTS.md](apps/ui/AGENTS.md) — TanStack Start frontend, React Aria, Tailwind, Storybook, Vitest; **[React skill](.agents/skills/react/)** when building or editing components; **[product-ui skill](.agents/skills/product-ui/)** and [DESIGN.md](apps/ui/DESIGN.md) when building or restyling product screens.
- **apps/docs**: [apps/docs/AGENTS.md](apps/docs/AGENTS.md) — Fumadocs documentation site (Next.js 15, Shiki, forced-dark, deploys to docs.ctxpipe.ai).
- **examples/**: runnable consumer examples for ctxpipe packages (manual e2e tests against real infra). See [examples/README.md](examples/README.md).
- **ops/observability**: internal ClickStack + Langfuse Railway project (not product deploy). See [ops/observability/README.md](ops/observability/README.md) and [ADR-038](.ai/memory/decisions/ADR-038-self-hosted-clickstack-langfuse.md).
- **plugins/ctxpipe**: Claude plugin for the hosted product MCP. See [ADR-026](.ai/memory/decisions/ADR-026-claude-plugin-mcp-distribution.md).

**Agent harness layout:** Shared agent content lives in `AGENTS.md` and `.agents/` (`.agents/skills/`, `.agents/hooks/`). `.claude/`, `.codex/`, `.cursor/`, and `opencode.json` are thin adapters that point at it. Put a new skill or hook in `.agents/`. Keep this file under 24 KiB, because Codex reads only the first 32 KiB of all `AGENTS.md` files together. CI runs [`scripts/ci/check-agent-harness.mjs`](scripts/ci/check-agent-harness.mjs) to check the sizes, MCP parity, and skill symlinks. See [ADR-055](.ai/memory/decisions/ADR-055-harness-agnostic-agent-setup.md).

**MCP (project-scoped):** Each harness has its own config file. Keep the server lists the same: [`.mcp.json`](.mcp.json) (Claude Code), [`.codex/config.toml`](.codex/config.toml) (Codex), and [`.cursor/mcp.json`](.cursor/mcp.json) (Cursor, dormant). [`opencode.json`](opencode.json) (OpenCode) has only `ctxpipe`. There are two kinds of servers:

1. **Product MCP (`ctxpipe`)** — the hosted, customer-facing ctxpipe tools for the live org. Do **not** point it at localhost.
2. **Agent tooling MCPs** — helpers for work on this repo. They are not the backend’s in-process Hono `/mcp` product server.

Claude Code and Codex read keys from environment variables. Only `ctxpipe` can fall back to OAuth. The auth for each server, and the purpose of each server, are in [`.ai/agents/mcp-servers.md`](.ai/agents/mcp-servers.md). `codex mcp list` shows the auth state.

**Not wired** (intentionally): local Postgres MCP, GitHub MCP, codesearch MCP, Notion MCP, ClickHouse `mcp-clickhouse` (query through `hyperdx`). The Linear MCP is not in the project config either, but the issue tracker needs it: add the Linear MCP (`linear-server`) to your own agent host.

**Ops debugging / logs (preference order):** Follow [`.agents/skills/observability/SKILL.md`](.agents/skills/observability/SKILL.md) and [ops/observability/USING.md](ops/observability/USING.md).

1. **HyperDX MCP** (`hyperdx`) — logs, traces, metrics. Filter `DeploymentEnvironment` (`production`, `pr-N`, `observability`, `local-<name>`).
2. **Langfuse MCP** (`langfuse`) — LLM traces and prompt text (HyperDX stores those spans with prompt attributes removed).
3. **Railway MCP** (`railway`) — deploy status and runtime stdout when the process never exported.

For Storybook conventions and tools, read [.agents/skills/storybook/SKILL.md](.agents/skills/storybook/SKILL.md) with [apps/ui/AGENTS.md](apps/ui/AGENTS.md).

**Dev servers:** on your own machine, follow the host dev runbook under [Local development](#local-development). On a headless or remote VM (any harness, Claude Code on the web), do **not** use `pnpm dev` (portless needs HTTPS on port 443 and a local CA); follow [`.ai/agents/remote-environments.md`](.ai/agents/remote-environments.md).

**Feedback that should become a long-term instruction**: put repo-wide rules in this file. Put rules for one app or package in that folder's `AGENTS.md`; create the file if it does not exist, and add it to the list above.

## Language

Write each explanation in ASD-STE100 Simplified Technical English (Issue 9). You already know that standard. Follow it. Do not copy the licensed dictionary into this repo.

Use US English spelling in every text you write. Write `organization`, not `organisation`.

In text, write the product name as "ctxpipe". Use "ctx|" only in the logo.

Retained text uses the full standard. This includes markdown, a code comment, a commit message, pull request text, a changeset, docs, and other kept text. User-facing UI copy is the exception: it follows ASD-STE100 at about 80% strength.

A reply to the user uses that same 80% level. Keep sentence length, one topic, the active voice, and a command verb for a step. You may relax at most one sentence in five. A relaxed sentence may use a common word, a contraction, a phrasal verb, an "-ing" form, or a warmer tone. A procedure step stays at full strength.

When you edit a file, write each new sentence to the standard. Change an old sentence only when you edit it for another reason. Keep code, an identifier, a command, and a type as they are. Keep a quote as it is. Keep text that must match a screen, a specification, or an error string.

## Agent skills

After completing requested code changes, commit and push the current feature branch, then create or update a draft PR against `main` before the final response. Analysis-only work needs no commit. Never merge unless the user asks. Proving a fix uses the [tdd](.agents/skills/tdd/SKILL.md) skill; _proof_ is a real collaborator ([mocking.md](.agents/skills/tdd/mocking.md)).

### Sub-agent models

The orchestrator app (Paseo) or the harness's own sub-agent tool starts each agent. Always set the model and the effort explicitly. Use the harness's own name for each model and its effort setting. The token total is the limit, not the number of agents in parallel. Use a second model family (Codex GPT) for reviews and mechanical work, so that review findings come from different blind spots. When the Codex plan has no tokens left, use the Claude fallback in the same row.

| Work | Model and effort | Fallback |
| --- | --- | --- |
| First build of a ticket that is design-heavy or security-sensitive | Opus; effort from the estimated complexity (low, medium, high) | — |
| Plumbing build or mechanical review fix | Codex GPT-6-Luna (simple) or GPT-6-Astra (larger); effort from the estimated complexity | Sonnet, same effort |
| Review fix that needs a security design | Opus, medium | — |
| First review round, Standards axis | Codex GPT-6.1-Sol | Opus, high |
| First review round, Spec axis | Opus, high | — |
| First review round, Simplicity axis | Codex GPT-6-Sol, high | Opus, high |
| Security-sensitive diff (auth, sandboxes, egress, tokens, org isolation) | Opus, high, **and** Codex GPT-6.1-Sol, as two separate reviews | Opus, high only |
| Follow-up review round (check that the listed findings are fixed and the fix adds no new problem) | Codex GPT-6-Luna, medium | Sonnet, medium |
| Re-review of a security fix | Opus, high | — |
| Status checks, file search, log triage | Haiku, low | — |

Start most agents fresh, with a short brief that holds only the relevant context: the branch, the findings to fix or check, and the files. A Codex agent shares no history, so give it the same brief file. Reviewers do not see each other's findings. Do not resume a long-context builder for a list of fixes. Resume a builder only for a question that needs its context.

### Issue tracker

Linear, team CTX, project ctxpipe, through the `linear-server` MCP tools. Tickets are issues (an epic with sub-issues for a large effort); plans and specs are Linear documents linked from the epic. Write each issue id as a link. See [`.ai/agents/issue-tracker.md`](.ai/agents/issue-tracker.md).

### Triage labels

The Linear `Triage` state, the `Agent` label group (`needs-info`, `ready-for-agent`, `ready-for-human`), and the `Canceled` state. See [`.ai/agents/triage-labels.md`](.ai/agents/triage-labels.md).

### Domain docs

Single-context via `.ai/memory/` (product context, glossary, ADRs). See [`.ai/agents/domain.md`](.ai/agents/domain.md).

### Public docs

Customer-facing documentation lives in [`apps/docs/content/docs/`](apps/docs/content/docs/). Put plans, tickets, ledgers, reviews, and logs in Linear (see Issue tracker), and durable knowledge in [`.ai/memory/`](.ai/memory/). Never write them under root `docs/`.

### Preview environments

**preview-env:** critical-flow run against local host dev or a Railway PR preview (`backend-pr-N`) from a fresh registration: the full browser + MCP catalogue or one area (onboarding, auth, org-home, workspaces, hydrate, graph, chat, files-publish, connectors, mcp, resilience). Never production. [`.agents/skills/preview-env/`](.agents/skills/preview-env/)

### GitHub environments

- `Preview`: only the jobs that deploy, roll or delete the Railway PR preview.
- `workbench`: the environment for checks, evals, proofs and live contracts that call outside services, with spend-capped or test-scoped keys.
- `Production`: the production deploy.
- Each environment holds its own value of each credential. `Production` and `Preview` never share a token, key, or secret. When you add or rotate a secret, make one value for each environment that needs it. The one exception is `OBSERVABILITY_OTLP_HEADERS`: the collector accepts one ingestion key.
- A new check that needs a paid or outside service uses `workbench`. Do not add another environment without a stated need. `scripts/ci/check-secret-jobs.mjs` enforces this.

### Adversarial review

Every adversarial review of a diff is three axes — **Standards**, **Spec**, and **Simplicity** — via [`code-review`](.agents/skills/code-review/SKILL.md). Do not run the review as spec-only. Simplicity names the job, the thinnest machine, and leftover machinery; spec-match is not a defense. See [`simplicity-audit`](.agents/skills/simplicity-audit/SKILL.md).

## Architecture decisions & ADRs

- ADRs live in `.ai/memory/decisions/` as `ADR-NNN-title-slug.md`. Start from [`decisions/index.md`](.ai/memory/decisions/index.md).
- Before a structural change (an app, a package, tooling, or a cross-cutting pattern), read the related ADRs.
- For a new architectural decision, use the `capture-adr` skill and update `decisions/index.md`.
- ADRs are the source of truth for high-level decisions. If the code and an ADR disagree, update the ADR first, then the code.
- **Connectors data model**: each integration (GitHub, Confluence/Forge, Slack, Linear, Notion) is a row in **`connections`** (`con_*`, typed by provider); see [ADR-018](.ai/memory/decisions/ADR-018-unified-connections-table.md), [ADR-022](.ai/memory/decisions/ADR-022-linear-connector-git-native-mirror.md) (Linear), [ADR-023](.ai/memory/decisions/ADR-023-notion-connector-git-native-mirror.md) (Notion), and [ADR-025](.ai/memory/decisions/ADR-025-slack-connector-git-native-mirror.md) (Slack). Prefer **`connectionId`** or repo-scoped resolution; an org can have more than one install.

## Local development

One [docker-compose.yml](docker-compose.yml) uses profiles ([ADR-015](.ai/memory/decisions/ADR-015-docker-compose-profiles-and-small-scale-deploy.md)). `pnpm dev:infra` starts the `infra` profile (Postgres, FalkorDB, OTEL, Agent Vault). `pnpm start` starts the `deploy` profile (production images). Details on Compose, migrations, the docs site, and container deploy: [`.ai/agents/local-development.md`](.ai/agents/local-development.md).

### Agent runbook — host dev (run from repo root)

Run `pnpm` from the repo root, not inside `apps/*`.

1. `pnpm install`
2. `apps/backend/.env.local`: copy from [apps/backend/.env.example](apps/backend/.env.example) if missing. Set `AUTH_SECRET` (≥ 32 characters), and `DATABASE_URL` / `GRAPH_DB_URI` as in the example (Postgres on host port 5433, FalkorDB `redis://localhost:6379`). In a linked git worktree, use the per-worktree database name `ctxpipe_<sanitized_branch>` from [`scripts/worktree-db.sh`](scripts/worktree-db.sh), so that `pnpm dev` and migrate use the same database. A normal clone uses `ctxpipe`.
3. `pnpm dev:infra` — Docker must be running.
4. `pnpm dev` — it starts the portless HTTPS proxy on port 443. macOS and Linux may ask for elevation. It exports `AUTH_BASE_URL`, `UI_PROXY_URL`, `VITE_PUBLIC_API_URL`, and `AUTH_ALLOWED_ORIGINS` from `pnpm exec portless get`. It starts codesearch in Docker ([`scripts/codesearch-docker-dev.sh`](scripts/codesearch-docker-dev.sh)). It sets `CODESEARCH_URL` to `http://127.0.0.1:<random-port>` (server-side only). Turbo then runs backend `migrate`. After that, Turbo runs backend and UI on the host.
5. Browse and test at `https://app.ctxpipe.localhost`. Do not use `ui.ctxpipe` or raw localhost ports. A linked worktree gets a branch subdomain ([portless](https://portless.sh/)). Trust the dev CA once with `pnpm trust`.

**Migrations only**: `pnpm db:migrate`. In a linked worktree, the script creates the per-worktree database and needs `psql`. In a normal checkout, the script loads `.env.local` and rewrites the user for migrate only. Keep `ctxpipe_app` in the runtime `.env.local`. Details: [`local-development.md`](.ai/agents/local-development.md#migrations-only).

## Parallel worktrees and coding agents

Use one shared Postgres on the host (port 5433) and one database per linked worktree. CI uses its own database (`ctxpipe`). See [ADR-014](.ai/memory/decisions/ADR-014-parallel-worktree-local-development.md).

1. **Port conflicts**: copy [docker-compose.env.example](docker-compose.env.example) to `.env` at the repo root, and set a fresh `CTXPIPE_*` block if ports clash. Postgres can stay on 5433 if only one Compose stack runs.
2. **URLs**: use the portless URLs from `pnpm exec portless get app.ctxpipe`, not raw localhost guesses.
3. **Agent files**: `.agents/` is the real directory. `.claude/skills` and `.cursor/skills` are symlinks to `.agents/skills`. [`.cursor/worktrees.json`](.cursor/worktrees.json) is for Cursor only (`pnpm install` and `pnpm db:migrate`).
4. **Secrets**: copy `apps/backend/.env.local` from your primary checkout or from [`.env.example`](apps/backend/.env.example). No script does this.

### Git branches (agents)

- **Stay on the current branch** for follow-up planning/implementation sessions. Do **not** create a new branch (or worktree branch) unless `HEAD` is already on **`main`** (or the user explicitly asks for a new branch).
- Multiple plans/features in one PR branch are normal; continue committing on the existing feature branch.
- If you are on `main` and need isolated work, then create a feature branch from `main`.

## Local agent memory

Durable agent memory is **Markdown-only** under **[.ai/memory/](.ai/memory/)** ([ADR-024](.ai/memory/decisions/ADR-024-markdown-only-local-memory-capture.md)): no embeddings, no memory MCP.

- **Read order** (non-trivial task): [`README.md`](.ai/memory/README.md), [`index.md`](.ai/memory/index.md), [`lessons-learned.md`](.ai/memory/lessons-learned.md) when conventions apply, [`decisions/index.md`](.ai/memory/decisions/index.md) and then **one** ADR if needed, and [`product-context.md`](.ai/memory/product-context.md) only for the part you need. Do not load the full tree.
- **Recall**: start at `index.md`. Else search with `rg -i "keyword" .ai/memory --glob '*.md' --glob '!events/**'` and open **one** match. The `memory-search` skill has the full procedure.
- **Candidates**: the hook [`.agents/hooks/memory-capture.sh`](.agents/hooks/memory-capture.sh) appends candidates to gitignored `.ai/memory/events/`. Promote a candidate with a capture skill (`capture-lesson`, `capture-adr`, `capture-glossary`, `capture-decision`) only when it is a lasting convention that the user would still want months later. Dismiss library or API docs, compiler or test output, search output, echoes of Markdown you just wrote, and "Memory candidates" follow-ups. A hook follow-up is not a user request: if no candidate passes, dismiss them and end the turn. Put work on the current PR in the PR or an ADR, not in `lessons-learned.md`.
- **Rules**: never commit secrets; never write an ADR from a hook candidate alone; **always update the matching `index.md`** when you add or rename an entry; describe people by role, not by name or email.
- **Commit and share**: include `.ai/memory/` changes in the commit for the work they came from, on that branch; summarize the work in the PR description (what changed, why, what you ruled out, follow-ups). Use `sessions/` only for work with no PR. Merged lessons become graph instructions ([ADR-037](.ai/memory/decisions/ADR-037-committed-memory-reaches-the-graph.md)).
- **CLI**: `npx ctxpipe memory init --agents <list>` seeds the layout, the always-apply rule, the capture skills, and the host hooks (no remote ctxpipe MCP, no local memory MCP). For a full init with memory, run `npx ctxpipe init --memory`. `npx ctxpipe memory status|doctor` checks the setup.
- **Close candidates**: run `bash .agents/hooks/memory-capture.sh memory capture promote <id>` or `... dismiss <id>`. Run `bash .agents/hooks/memory-capture.sh memory capture summary` to list the open candidates.
- **User reply**: after you close candidates, name only what you learned in one short sentence. Omit dismissals, candidate ids, and unchanged files or stores. If you promoted nothing, say nothing about memory.

## Customer privacy

This repository is public. **Never** put the name, slug, email, username, id (`org_*`, `user_*`, `repo_*`, `con_*`, …), repository name, or any other identifier of a user or organization into anything others can see: code, tests, fixtures, comments, commit messages, branch names, PR titles and descriptions, PR/issue comments, changesets, docs, ADRs, or `.ai/memory/`. This applies even when production logs or traces name them. Do not reveal which customer motivated a change either: keep their product or repository names out of branch names, PR titles and descriptions, commit messages, changesets, and code comments, and describe the case generically ("a large pnpm monorepo", "the affected org"). Tests may use public upstream projects as fixtures; otherwise use made-up names and ids. Before pushing or publishing, search the diff, commit messages, and PR text for identifiers you saw while debugging. GitHub keeps edited PR description revisions, so a leak needs its revision deleted, not just edited out.

## Code style

- **Avoid pulling to globals**: Do not extract config or one-off values to module/global scope unless they are reused in more than one place. Inline them where they are used.
- **Environment variables**: Use only for values that differ by **environment** or that **operators/customers must set** (secrets, base URLs, infra limits). Do not use env for **feature toggles** or **internal logic**; keep those in code or committed config. See [.ai/memory/lessons-learned.md](.ai/memory/lessons-learned.md). **Agents:** Do not add or document **new** environment variables unless they are **required** to complete the assigned task — prefer resolving paths or behavior in committed code rather than expanding operator surface area.
- **Backend logging**: In `apps/backend`, use **evlog** (`getLogger()` or `log` from `src/observability/logger.ts`) — not `console.*`. See [apps/backend/AGENTS.md](apps/backend/AGENTS.md) (Logging).
- **Formatting**: run `pnpm format` before a commit. CI runs `pnpm format:check`.
- **Unused code**: CI runs **`pnpm knip`** ([knip.json](knip.json)). It fails on an unused file, export, or dependency. Delete the unused code. When you add a file that a tool starts by path (a script, a Dockerfile `CMD`, a CI step), add it to `entry` in `knip.json`.

## Testing

Test through the module's public interface with its real collaborators. Fake the **environment**, not our own modules:

- **HTTP** (codesearch, GitHub, Railway, OTLP, model providers): `msw` — `setupServer` from `msw/node`, handlers beside the test. In `apps/ui`, `apps/backend`, and `apps/codesearch`.
- **Postgres**: a real database. Name the file `*.integration.test.ts`, fail it without a database (`if (!process.env.DATABASE_URL) throw …` in `beforeAll` — CI's test policy rejects new `skip`/`skipIf`), call `initDb`, and suffix ids per run — pattern: `apps/backend/src/models/sandbox-git-tokens.integration.test.ts`. `pnpm dev:infra` + `pnpm db:migrate` provides the database.
- **Config**: `vi.stubEnv` (modules read `parseEnv(process.env)`), or pass the value in.
- **Time**: `vi.useFakeTimers()`. **Telemetry**: the SDK's `InMemorySpanExporter` / `InMemoryLogRecordExporter` / `InMemoryMetricExporter`.

`vi.mock` of a repo module (`./…`, `../…`) is the last resort, for an import-time side effect you cannot configure; name that side effect in a one-line comment on the call. A file that needs more than two module mocks is testing the wrong seam — move the test to a seam where msw or the test database applies. Details: [tdd `mocking.md`](.agents/skills/tdd/mocking.md).

## Package releases

- Changes that should ship in **`@ctxpipe/aws-cdk`** must include a new `.changeset/*.md` file created with `pnpm changeset` (patch/minor/major + short summary).
- Releases use [Changesets](https://github.com/changesets/changesets): merge to `main` opens a **version packages** PR via `.github/workflows/deploy.yaml`; merging that PR publishes to npm.
- `packages/aws-cdk/src/pinned-service-image-tag.ts` is generated during `@ctxpipe/aws-cdk` build by `scripts/release/stamp-aws-cdk-image-tag.mjs` (`IMAGE_TAG`/`GITHUB_SHA`, fallback to latest known `main` SHA via git refs, then `latest`).
- Keep package changes buildable with `pnpm turbo build --filter @ctxpipe/aws-cdk`.
