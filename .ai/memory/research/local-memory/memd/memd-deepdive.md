# memd Deep Dive

Research date: 2026-05-24

## Sources

- Landing page: https://memd.dev/
- npm package referenced by site: https://www.npmjs.com/package/@memd/mcp
- Broken/placeholder GitHub target surfaced from site click during research: https://github.com/user/memd
- Local prior research: [details](./memd-details.md), [content](./memd-content.md), [sentiment](./memd-sentiment.md)

## Executive Read

memd is architecturally interesting because it models exactly the things coding agents tend to forget: decisions, patterns, errors, schemas, constraints, solutions, checkpoints, progress logs, sessions, and tasks. Its public API surface is crisp and workflow-oriented.

The main problem is confidence. The site advertises open source, self-hosted, MIT licensing, and "your data stays yours", but the visible quickstart uses a hosted backend at `api.memd.dev`, and the GitHub link encountered during this pass pointed to `github.com/user/memd`, which 404s. Until the canonical repository and self-hosting docs are verified, memd should be treated as a promising design reference, not a vetted local-first dependency.

## What It Is

memd is positioned as an open-source MCP server for AI coding-agent long-term memory. It is meant to let any MCP-compatible agent store and retrieve durable coding context.

Target clients named on the site:

- Claude Code;
- Copilot;
- Cursor;
- any MCP-compatible agent.

Primary category: structured coding-agent memory API.

Secondary categories:

- task tracker;
- checkpoint system;
- progress/audit log;
- session lifecycle tracker;
- semantic/structured search backend.

## Implementation And Language

Public site describes a three-layer architecture:

1. AI agent layer
2. MCP server layer
3. memd API/backend layer

Implementation details from the site:

- MCP server: TypeScript over stdio transport;
- API backend: Go, stateless;
- structured storage: PostgreSQL;
- vector search: Qdrant;
- embeddings: ONNX local with OpenAI fallback;
- setup: npm package `@memd/mcp`;
- protocol: MCP;
- default backend in quickstart: hosted at `api.memd.dev`.

License/source caveat:

- The site says open-source, self-hosted, MIT licensed.
- The source link encountered during research went to a placeholder/404 URL.
- Search did not surface a clear canonical GitHub repository for this exact memd project.
- Therefore source, schema, migrations, local deployment, and license should be verified before adoption.

## Storage Model

Documented storage:

- PostgreSQL for structured storage and queries;
- Qdrant for vector similarity;
- embeddings generated through local ONNX or OpenAI fallback.

Documented object types:

- context entries;
- checkpoints;
- progress logs;
- sessions;
- tasks.

Documented context entry fields:

- key;
- type;
- priority;
- scope;
- tags;
- TTL.

Inferred backend model:

- unique keys allow direct recall;
- type/scope/tags/priority allow SQL-style filtering;
- vector embeddings enable semantic search;
- TTL and priority drive cleanup;
- tasks/checkpoints/progress are separate tables or collections rather than generic memories.

This separation is one of memd's strongest ideas.

## Memory Content Model

The public site says there are 10 entry types and explicitly names:

- decisions;
- patterns;
- errors;
- schemas;
- constraints;
- solutions;
- and more context categories.

It also exposes non-entry work-state objects:

- checkpoints;
- progress logs;
- sessions;
- persistent tasks.

This is one of the most coding-specific ontologies in the survey.

## Examples Of What It Stores

Site example:

```text
memd_store key="auth-flow" type=decision
Stored -> persists across all sessions.

memd_search query="auth" hybrid=true
3 results (38ms) - semantic + structured

memd_recall key="auth-flow"
JWT + refresh tokens, rate limit at gateway...
```

Example decision memory:

```json
{
  "key": "auth-flow",
  "type": "decision",
  "priority": "high",
  "scope": "repo",
  "tags": ["auth", "jwt", "rate-limit"],
  "ttl": null,
  "content": "Use JWT access tokens with refresh-token rotation; enforce rate limiting at the gateway."
}
```

Example schema memory:

```json
{
  "key": "billing-schema-subscriptions",
  "type": "schema",
  "priority": "critical",
  "scope": "packages/billing",
  "tags": ["database", "subscriptions"],
  "content": "subscriptions.customer_id references customers.id; status is one of active, canceled, trialing."
}
```

Example checkpoint:

```json
{
  "task": "replace-memory-layer",
  "completed": [
    "surveyed 25 memory tools",
    "ranked sentiment",
    "created shortlist"
  ],
  "blockers": [],
  "next_actions": [
    "finish deep dives",
    "draft architecture proposal"
  ]
}
```

Example progress log:

```json
{
  "session": "2026-05-24-local-memory-research",
  "action": "created shortlist deep dives",
  "files_changed": [
    ".ai/memory/research/local-memory/*-deepdive.md"
  ],
  "outcome": "research corpus now has detailed evidence for five candidates"
}
```

Example persistent task:

```json
{
  "title": "Design repo-local memory architecture",
  "status": "blocked",
  "priority": "high",
  "blocked_by": ["finish deep dives"],
  "dependencies": ["compare shortlist"]
}
```

## Extraction And Prompt Availability

No public extraction prompt was found.

memd appears to rely on:

- typed MCP tools;
- tool descriptions;
- agent instructions;
- explicit API fields.

That means extraction is likely delegated to the active coding agent: the agent decides when to call `memd_store`, which type to choose, which key to use, and how to write the content.

This has a clear tradeoff:

- positive: strong schema guides the agent and avoids one generic "remember" bucket;
- negative: no visible specialized extractor, deduper, or review stage.

If adopting or copying memd's approach, the missing piece is a high-quality prompt/protocol for when to store:

- decision versus constraint;
- error versus solution;
- schema versus pattern;
- checkpoint versus progress log;
- task versus memory.

## API And Tool Surface

Documented tools:

| Tool | Purpose |
|---|---|
| `memd_store` | Save a context entry with type, priority, tags, TTL. |
| `memd_recall` | Retrieve a specific entry by key. |
| `memd_search` | Hybrid semantic plus structured search. |
| `memd_list` | Filter entries by type, scope, tags, priority. |
| `memd_update` | Partial update to an existing entry. |
| `memd_delete` | Permanent delete. |
| `memd_checkpoint_*` | Save, get, list, delete development snapshots. |
| `memd_progress_log` | Append action to session audit trail. |
| `memd_session_*` | Start and end working sessions. |
| `memd_task_create` | Create persistent task with priority and dependencies. |
| `memd_task_update` | Update status, priority, blockers. |
| `memd_task_list` | List tasks filtered by status/priority. |
| `memd_task_get` | Retrieve task by id. |
| `memd_task_delete` | Delete a task. |

The site summarizes this as "19 tools, one protocol".

## Retrieval And Use Path

Documented setup:

```text
npx @memd/mcp:latest --setup
```

MCP config example from the site uses:

```json
{
  "mcpServers": {
    "memd": {
      "command": "npx",
      "args": ["@memd/mcp"],
      "env": {
        "MEMD_API_URL": "https://api.memd.dev",
        "MEMD_API_KEY": "your-key"
      }
    }
  }
}
```

Retrieval paths:

- recall by key for exact known memory;
- list/filter by type/scope/tags/priority;
- search by hybrid semantic plus structured search.

The site claims SQL filters and vector search run in parallel, then results are merged.

## Memory Soup Controls

memd's controls are mostly schema-level:

- typed entries;
- unique keys;
- scopes;
- tags;
- priority;
- TTL;
- critical/high-priority protection from auto cleanup;
- SQL filters;
- vector search;
- separate checkpoints;
- separate progress logs;
- separate session lifecycle;
- separate persistent tasks;
- status/priority/dependency fields on tasks.

Strong aspects:

- durable knowledge is not mixed with raw progress logs;
- checkpoints preserve resumable state without pretending every step is a durable pattern;
- task state does not have to live in memory prose;
- TTL acknowledges memory expiry;
- priority acknowledges that not all facts age the same way.

Weak aspects:

- no public dedupe story;
- no public extraction prompt;
- no public provenance story beyond possible progress logs;
- no visible review queue;
- no branch/worktree model surfaced;
- no visible redaction story;
- no contradiction handling surfaced;
- no visible generated summary layer.

## Architecture Choices

### Typed MCP Tools

Benefits:

- agent has explicit affordances;
- users can understand memory categories;
- workflows map to coding tasks;
- easier to filter than generic vector memory.

Costs:

- agent still chooses the right type;
- schemas can become underused if tool descriptions are weak;
- broad API needs training/examples.

### Postgres Plus Qdrant

Benefits:

- mature structured queries;
- scalable vector search;
- separate responsibilities;
- easier API service deployment.

Costs:

- heavy for local-first repo memory;
- more moving pieces than SQLite/Markdown;
- backup/export is more complex;
- local dev setup can be annoying.

### Hosted API Default

Benefits:

- fast setup;
- no local backend ops;
- easy trial.

Costs:

- conflicts with local-first expectations;
- requires API key;
- code memory may leave the machine;
- self-hosting claim must be verified.

### TTL/Priority Cleanup

Benefits:

- explicit memory lifecycle;
- stale low-priority context can expire;
- critical knowledge can be protected.

Costs:

- TTL can remove rare but useful context;
- priority can be misassigned;
- cleanup needs audit.

## Benchmarks And Evidence

Public benchmark evidence found:

- site claims hybrid search under 50 ms in headline metric;
- example search result shows 38 ms;
- no formal benchmark page, benchmark repo, or independent evaluation found in this pass;
- no public long-term user reports surfaced.

Interpretation:

- memd's architecture looks practical, but evidence is thin.
- Performance claims are plausible for small/local search but unvalidated.
- The most important validation would be not speed but relevance, stale-memory resistance, local self-host setup, and agent write quality.

## Sentiment

Public sentiment is sparse.

Positive design signals:

- users want exactly these memory types;
- typed API is more credible than generic memory;
- checkpoints and progress logs match coding-agent work.

Caution signals:

- hosted API default;
- unclear canonical source repository;
- infrastructure weight;
- no independent reports;
- no public extraction prompt.

Confidence: low.

## Pros

- Excellent coding-memory ontology.
- Clean MCP tool surface.
- Separates memory, checkpoints, logs, sessions, and tasks.
- Priority and TTL are built into the model.
- Hybrid structured/semantic search.
- Go stateless backend is a reasonable API design.
- TypeScript MCP layer matches Node-based agent clients.
- Task dependencies and blockers are very relevant.
- Progress logs give a raw audit trail without polluting distilled memory.

## Cons

- Canonical source repository not verified.
- Site source link encountered as placeholder/404.
- Local-first/self-hosted story unclear despite marketing.
- Hosted API key default may be unacceptable for code memory.
- Postgres plus Qdrant is heavy for solo local memory.
- No public prompt/extraction logic found.
- No public benchmarks beyond landing-page metrics.
- Sparse public user sentiment.
- No visible branch/worktree support.
- No visible redaction/provenance/contradiction model.

## Gaps And Missing Facets

Must verify:

- actual GitHub repository;
- license file;
- self-host deployment docs;
- schema and migrations;
- auth/API key model;
- local-only mode;
- export/import;
- backups;
- redaction;
- prompt/tool descriptions;
- dedupe logic;
- update semantics;
- branch/worktree scoping;
- relationship between progress logs and context entries;
- how checkpoints are restored/injected;
- whether Qdrant is mandatory;
- whether OpenAI fallback can be disabled;
- how TTL cleanup is audited.

## Fit For Individuals

Mixed.

Good if:

- hosted API is acceptable;
- user wants typed memory immediately;
- user already runs Postgres/Qdrant or does not mind hosted backend;
- user values checkpoints and tasks.

Less good if:

- user wants zero-cloud local-first;
- user wants file-readable memory;
- user does not want extra services;
- user needs inspectable source today.

## Fit For Teams

Potentially useful if the backend is real and self-hostable.

Team strengths:

- centralized API;
- structured records;
- tasks/dependencies;
- progress logs;
- sessions.

Team risks:

- hosting/privacy;
- access control not surfaced;
- no visible review workflows;
- no source verification;
- schema migration and data retention unknown.

## Security And Privacy

Positive:

- typed memory can avoid dumping raw context into one bucket;
- local ONNX embeddings are mentioned;
- priority and TTL can limit retention.

Risks:

- default setup points to hosted API;
- API key required;
- OpenAI fallback may send content externally if configured;
- no public redaction model found;
- progress logs can capture file changes/outcomes that reveal sensitive data;
- no visible audit of TTL deletes or permanent deletes beyond tool semantics.

## Design Lessons For ctxpipe

High-value ideas to copy:

- typed entries: decision, pattern, error, schema, constraint, solution;
- separate checkpoints;
- separate progress logs;
- separate sessions;
- separate persistent tasks;
- key-based recall;
- scope/tags/priority/TTL fields;
- hybrid structured plus semantic search;
- priority-aware cleanup.

Ideas to avoid or treat carefully:

- hosted backend as default for code memory;
- Postgres/Qdrant before proving local need;
- opaque source/deployment story;
- relying on agent tool calls without strong examples and review.

## Bottom Line

memd is a strong ontology reference and a weak adoption reference. Its typed model should absolutely inform a ctxpipe memory design. But until source, license, self-hosting, and local-only behavior are verified, it should not be treated as a proven local-first solution.

