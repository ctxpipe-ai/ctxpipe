# Project Glossary

## Terms
| Term | Definition |
|------|------------|
| ctxpipe | The monorepo and product name — a code-context platform |
| Zoekt | Google's open-source code search engine, used for indexing and searching repositories |
| MCP | Model Context Protocol — AI tool interface exposed alongside REST APIs |
| Better Auth | TypeScript authentication framework used in the backend |
| Drizzle | TypeScript ORM (beta/v1 API) for PostgreSQL |
| React Aria | Adobe's accessibility-focused React component primitives |
| TanStack Start | Full-stack React framework with file-based routing (used in apps/ui) |
| Agent benchmark (Harbor) | Repeatable Harbor task suite comparing coding-agent performance across controlled arms (local workspace vs ctxpipe MCP), runnable locally and in CI |
| Benchmark arm — baseline (local) | Agent has a normal developer workspace on disk and no ctxpipe MCP; used as the comparison arm for org-context tasks. For v1, only the **primary repo** is on disk; sibling repos are not cloned locally |
| Primary repo (benchmark fixture) | The single repository present in the baseline arm’s workspace—the repo the simulated developer is “working in” |
| Benchmark arm — ctxpipe (MCP) | Agent has no local org-repo clones; org knowledge and cross-repo discovery go through ctxpipe MCP (e.g. `ctx_advisor`) against a pre-ingested org |
| Org-context advantage (benchmark hypothesis) | Primary success criterion for the agent benchmark: on tasks where organizational knowledge matters, the ctxpipe MCP arm scores higher than the local baseline because indexed org context beats grepping an incomplete local checkout |
| Benchmark task deliverable (structured answer) | Agent writes a fixed-schema artifact (e.g. `answer.json`); verifier compares fields to an oracle deterministically (no LLM judge required for v1) |
| Benchmark fixture (public snapshot) | Pinned commits of real upstream GitHub repos cloned at Harbor image build time; oracle and Harbor task metadata are authored in-repo (not vendoring upstream benchmark suites) |
| BoxyHQ org fixture | v1 public multi-repo benchmark snapshot: primary [`boxyhq/saas-starter-kit`](https://github.com/boxyhq/saas-starter-kit); siblings [`ory/polis`](https://github.com/ory/polis) (SSO engine, formerly BoxyHQ Jackson) and [`boxyhq/ui`](https://github.com/boxyhq/ui); SHAs pinned in a lockfile |
| Benchmark ctxpipe runtime (hosted) | For scored runs (e.g. GHA), ctxpipe runs **out-of-band** on a dedicated hosted instance—not inside the Harbor task. Operator pre-ingests the benchmark org at lockfile SHAs **manually** before trials; Harbor only needs reachability + auth |
| `CTXPIPE_MCP_URL` (benchmark) | Required arm config: full MCP streamable-http URL (e.g. `https://…/mcp?orgSlug=boxyhq-bench`). Overridable locally to any instance; CI uses a fixed benchmark-hosted URL |
| `CTXPIPE_API_TOKEN` (benchmark) | Required secret for the ctxpipe MCP arm: authenticates to protected MCP on the hosted instance |
| Hosted benchmark org | Dedicated ctxpipe organization (slug TBD) on benchmark infrastructure; fixture repos ingested at pinned SHAs before `harbor run`; not arbitrary customer production |
| Benchmark task v1 — env bridge (BoxyHQ) | First Harbor task (shape A): from **primary** `saas-starter-kit` only on disk, list `JACKSON_URL`, `JACKSON_EXTERNAL_URL`, `JACKSON_API_KEY`; from **ory/polis`, report SAML path prefix `/api/oauth/saml` and source file `lib/env.ts`. Deliverable: `answer.json` with exact-string oracle (see session 2026-05-28); values pinned to lockfile SHAs |
| Benchmark harness — smoke | Harbor `-a oracle`: runs reference `solution/solve.sh`; validates task/oracle/verifier in CI (not the org-context hypothesis) |
| Benchmark harness — scored (v1 default) | Harbor `-a cursor-cli`: real coding agent for baseline vs ctxpipe arm comparison; same agent and model settings on both arms; MCP only on ctxpipe arm via `task.toml` |
| Benchmark org memory (v1) | **No synthetic ADRs** in hosted benchmark org for v1 — hypothesis tested via ingested fixture repos only, not hand-authored org docs |

## Abbreviations
| Abbrev | Expansion |
|--------|-----------|
| ADR | Architecture Decision Record |
| ORM | Object-Relational Mapping |

---
*Last updated: 2026-05-28*
