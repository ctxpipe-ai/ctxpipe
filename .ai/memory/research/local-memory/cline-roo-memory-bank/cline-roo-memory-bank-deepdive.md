# Cline / Roo Memory Bank Deep Dive

Research date: 2026-05-24

## Sources

- Cline Memory Bank docs: https://docs.cline.bot/prompting/cline-memory-bank
- Current Cline Memory Bank page: https://docs.cline.bot/best-practices/memory-bank
- Cline Memory Bank custom instructions section: https://docs.cline.bot/best-practices/memory-bank#memory-bank-custom-instructions
- Roo Code Memory Bank repository: https://github.com/GreatScottyMac/roo-code-memory-bank
- Roo Code Memory Bank MCP server example: https://github.com/IncomeStreamSurfer/roo-code-memory-bank-mcp-server
- Paper Compute Cline memory product note: https://papercompute.com/cline/
- DataCamp Cline guide: https://www.datacamp.com/tutorial/cline-ai
- Local prior research: [details](./cline-roo-memory-bank-details.md), [content](./cline-roo-memory-bank-content.md), [sentiment](./cline-roo-memory-bank-sentiment.md)

## Executive Read

Cline / Roo Memory Bank is not a conventional memory product. It is a prompt-and-files methodology for making a coding agent treat a small set of repo-local Markdown files as its durable memory. The pattern is simple: read the files at task start, write them after meaningful progress, and use them to survive context-window resets.

The best thing about it is trust. The memory is human-readable, git-friendly, editable, portable, and easy to explain. It directly targets the most common coding-agent pain: "I just explained all this in the previous session." The worst thing about it is that it has almost no machinery. There is no semantic search, no deduplication, no confidence, no decay, no provenance beyond the text itself, no conflict handling, and no guarantee the agent will update the right file at the right granularity.

For ctxpipe, this is still the baseline to beat. A better system should preserve Memory Bank's legible file roles while adding lifecycle, scoping, search, review, and structured records.

## What It Is

Cline Memory Bank is a structured documentation method published by Cline. It turns project state into a set of Markdown files under a `memory-bank/` folder. Cline's public instructions explicitly tell the agent that its memory resets between sessions and that the Memory Bank is the source of truth after every reset.

Roo Code Memory Bank is a community implementation/adaptation of the same idea for Roo Code. It adds mode-oriented behavior and often adds `decisionLog.md`, VS Code/Roo prompt configuration, and more automated update expectations.

The pattern can be used by any agent with filesystem access:

- Cline
- Roo Code
- Claude Code
- Codex
- Cursor
- Aider
- Gemini CLI
- any MCP/file-capable custom agent

## Positioning

Primary category: local coding-project memory.

Secondary category: work-state and project documentation.

It is not primarily:

- a vector memory system;
- a knowledge graph;
- a database;
- a background daemon;
- a multi-user collaboration platform;
- a benchmarked retrieval engine.

The pattern's value is not advanced recall. It is structured continuity.

## Implementation And Language

There is no core runtime language for Cline Memory Bank itself. The implementation is:

- Markdown files;
- custom instructions / Cline rules;
- optional commands or slash-command workflows;
- optional community wrappers.

Roo Code Memory Bank is a public GitHub repository with mode/config files and an Apache-2.0 license surfaced on GitHub. Its "implementation" is still mostly project templates, prompt instructions, and supporting files rather than a database-backed memory runtime.

The Roo MCP server example implements initialization and file management as an MCP layer, but the underlying durable data remains Markdown files.

## Storage Model

Canonical Cline layout:

```text
memory-bank/
  projectbrief.md
  productContext.md
  activeContext.md
  systemPatterns.md
  techContext.md
  progress.md
```

Common Roo layout:

```text
memory-bank/
  activeContext.md
  decisionLog.md
  productContext.md
  progress.md
  systemPatterns.md
projectBrief.md
```

Cline's file roles:

| File | Role |
|---|---|
| `projectbrief.md` | Core requirements, goals, and project scope. |
| `productContext.md` | Why the project exists, user problems, desired behavior, UX goals. |
| `activeContext.md` | Current focus, recent changes, next steps, active decisions, current learnings. |
| `systemPatterns.md` | Architecture, design patterns, component relationships, critical implementation paths. |
| `techContext.md` | Technologies, development setup, constraints, dependencies, tool usage patterns. |
| `progress.md` | What works, what remains, current status, known issues, evolution of decisions. |

Roo commonly adds:

| File | Role |
|---|---|
| `decisionLog.md` | Architectural choices and rationale. |
| `projectBrief.md` | Optional initial project prompt/context at project root. |

Storage properties:

- source of truth is local Markdown;
- no generated index is required;
- memory can be versioned with the repo;
- users can edit memory directly;
- there is no canonical schema beyond headings and prompts.

## Memory Content Model

The ontology is simple and practical:

- project requirements;
- product rationale;
- current focus;
- recent work;
- next steps;
- active decisions;
- architecture patterns;
- component relationships;
- implementation paths;
- tech stack;
- local setup;
- dependencies;
- known issues;
- completed work;
- not-yet-built work;
- discovered patterns and preferences;
- optional feature docs, API docs, test strategy, deployment docs, integration notes.

This is coding knowledge and work-management state, not generic personal memory.

## Examples Of Memories It Stores

Example `activeContext.md` entry:

```markdown
## Current Focus

- Replacing the session memory system.
- Evaluating local-first coding-agent memory designs.

## Recent Changes

- Added sentiment leaderboard.
- Added content-model research for 25 systems.

## Next Steps

- Compare shortlisted systems.
- Decide which parts become repo-local Markdown, task graph, and searchable index.

## Active Decisions

- Prefer human-readable source-of-truth files over opaque vector-only storage.
```

Example `systemPatterns.md` entry:

```markdown
## Backend API Pattern

- Use Hono RPC for typed internal API routes.
- Keep OpenAPI and Zod schema changes aligned.
- In backend code, use evlog instead of console logging.
```

Example `progress.md` entry:

```markdown
## Memory Redesign Research

- Done: initial 25-solution survey.
- Done: sentiment leaderboard.
- Done: memory-content classification.
- Remaining: architecture proposal and implementation plan.
```

Example `decisionLog.md` entry in Roo style:

```markdown
## 2026-05-24: Keep task graph separate from knowledge memory

Rationale: task dependencies, blockers, and ready work change at a different cadence from durable architecture knowledge.

Consequences:
- Durable project knowledge can remain concise.
- Work state can support claim/ready/blocked transitions without polluting architecture docs.
```

## Extraction Prompt And Write Logic

Cline publishes the full custom instructions in the docs. The important features of that prompt are:

- the agent is told that its memory resets completely between sessions;
- it must read all Memory Bank files at the start of every task;
- files are hierarchical, with `projectbrief.md` shaping the others;
- updates happen when discovering new project patterns;
- updates happen after significant implementation changes;
- updates happen on explicit "update memory bank";
- the agent must review all files when the user asks for a full update;
- the system emphasizes precision and clarity.

Roo variants move the same concept into mode-specific prompts:

- Architect mode emphasizes architecture and pattern documentation.
- Code mode emphasizes implementation progress and applied patterns.
- Ask mode emphasizes knowledge explanation and documentation.
- Debug mode emphasizes problems, fixes, and root-cause notes.

Prompt availability:

- Cline full instruction body: public in docs.
- Roo prompt/config bodies: public in community repositories.
- No hidden extraction model is required. The active coding model itself writes the memory.

Extraction quality depends entirely on instructions and model discipline. There is no external validator that decides whether a memory is durable, redundant, stale, or wrong.

## Retrieval And Use Path

The retrieval path is explicit:

1. Start or resume a task.
2. Ask the agent to follow its custom instructions.
3. Agent reads Memory Bank files.
4. Agent reconstructs project state from the file set.
5. During or after work, agent updates relevant files.
6. On context-window pressure, user asks "update memory bank", then starts a fresh session.

Cline docs also mention using context-management commands like `/newtask` and `/smol` alongside Memory Bank. The key point is that Memory Bank is used to preserve state before or after context compaction.

There is no automatic relevance ranking. The whole core set is read, or a human/agent chooses a subset.

## Memory Soup Controls

Built-in controls:

- fixed file roles;
- separate current state from stable project brief;
- separate product rationale from system architecture;
- separate technology/setup from progress;
- explicit update triggers;
- direct human editing;
- optional additional files for large features;
- ability to version and diff changes in git.

Weak or missing controls:

- no deduplication;
- no stale-memory detection;
- no confidence score;
- no source/provenance metadata per fact;
- no branch/worktree scope;
- no TTL or decay;
- no conflict detection;
- no review queue;
- no automated secret redaction;
- no semantic search;
- no incremental retrieval;
- no concurrency locking;
- no schema validation.

The fixed roles reduce chaos, but they do not solve "memory soup" once a project has months of accumulated notes. The usual failure mode is a bloated `activeContext.md` or `progress.md` that contains old details that should have been archived, deleted, or promoted into stable docs.

## Architecture Choices

### Human-Readable Source Of Truth

Everything important lives in Markdown. This is the strongest design choice.

Benefits:

- inspectable;
- editable;
- versionable;
- portable across agents;
- easy to back up;
- easy to review in a PR.

Costs:

- weak query behavior;
- no typed relationships;
- relies on agent discipline;
- can become verbose.

### Fixed Memory Roles

The file set encodes an ontology. This is why Memory Bank works better than one giant `memory.md`.

Benefits:

- agent knows where to look;
- user knows where to correct;
- current work can change frequently without rewriting project foundations;
- stable patterns can be separated from task status.

Costs:

- some information fits multiple files;
- agents can duplicate content across files;
- boundaries are only enforced by instructions.

### Agent-Managed Updates

The coding agent writes memory directly.

Benefits:

- no separate extraction service;
- no extra infrastructure;
- new facts can be captured immediately;
- easy to adapt to new file roles.

Costs:

- agent may over-save;
- agent may under-save;
- agent may summarize incorrectly;
- agent may preserve transient details as permanent facts.

### No Index By Default

Retrieval is "read the docs", not "query a memory database".

Benefits:

- deterministic and transparent;
- no index drift;
- no vector-store dependency.

Costs:

- startup token cost grows with file size;
- search becomes manual;
- old facts compete with current facts.

## Benchmarks And Evidence

Formal benchmarks: none found for Memory Bank itself.

Evidence base:

- official Cline docs describe Memory Bank as a best-practice pattern;
- Cline docs define the file hierarchy and custom instruction prompt;
- community Roo repositories have meaningful adoption and stars;
- Reddit and community discussions are positive but anecdotal;
- third-party tutorials describe Memory Bank as a practical way to preserve context across sessions;
- product notes like Paper Compute describe Memory Bank as the official workaround for Cline long-term memory limitations.

Interpretation:

Memory Bank is not benchmarked on recall accuracy because it is not a retrieval algorithm. Its benchmark is practical continuity: can a new session resume without the user re-explaining the project?

Sentiment is positive because the pattern is simple, local, and understandable. Users tolerate its limitations because those limitations are visible.

## Pros

- Extremely low infrastructure burden.
- Works with any file-reading coding agent.
- Strong local-first story.
- Fully inspectable and editable.
- Git-friendly.
- Good separation of stable context, active context, architecture, tech setup, and progress.
- Clear recovery story after context reset.
- Easy for individuals to adopt.
- Easy to customize.
- Good first layer even if a richer search layer is added later.

## Cons

- Manual discipline is the whole system.
- No automatic capture except agent self-edits.
- No structured metadata per fact.
- No source links unless users/agents add them manually.
- No semantic search.
- No lifecycle management.
- No conflict resolution.
- No freshness model.
- No secret filtering.
- No branch/worktree awareness.
- No team coordination beyond git.
- Can rot if not actively maintained.
- Can cause agents to spend too much context reading stale docs.

## Gaps And Missing Facets

Missing facets for a serious local coding memory system:

- typed records for decisions, patterns, errors, constraints, checkpoints, and tasks;
- per-memory scope: repo, branch, package, file, user, team;
- provenance: source conversation, file, commit, date, agent, human reviewer;
- confidence and verification state;
- review queue for auto-captured candidates;
- stale-memory detection;
- merge/split/archive operations;
- task/work graph;
- search index as rebuildable artifact;
- startup protocol with "hot context" and "cold search";
- memory update tests or linting;
- branch-aware memory conflicts;
- redaction rules;
- explicit deletion/audit history.

## Fit For Individuals

Excellent. A solo developer can adopt Memory Bank in minutes. The pattern has nearly no operational burden and is especially good for a single repo with one main agent.

Best individual use cases:

- preserving active work after compaction;
- keeping architecture decisions available;
- teaching the agent local setup and conventions;
- reducing repeated project explanations;
- carrying context across agents.

## Fit For Teams

Good as a shared documentation convention, weaker as a multi-agent memory system.

Team strengths:

- memories can be committed and reviewed;
- shared project rules can live in the repo;
- humans can inspect every durable fact.

Team weaknesses:

- concurrent agent writes can conflict;
- no ownership model;
- no permission separation between global/user/team memory;
- stale facts may spread if merged without review;
- no task claiming or dependency graph.

## Security And Privacy

Security posture is straightforward:

- memory lives in local files;
- no cloud service is required;
- no API calls are required just to store memory.

Risks:

- agents can write secrets into Markdown;
- committed memory files can leak sensitive information;
- no automatic redaction exists;
- hidden prompt-injection can become durable if copied into memory;
- users may forget Memory Bank is part of the repo and push it.

Recommended mitigation:

- add memory files to git only when intentionally shared;
- define redaction rules;
- require source links for security-sensitive facts;
- avoid storing credentials or raw logs;
- use review before committing memory changes.

## Design Lessons For ctxpipe

Keep:

- fixed human-readable file roles;
- concise active context;
- project/product/system/tech/progress separation;
- explicit "update memory" operation;
- git-friendly source of truth;
- direct human editability.

Improve:

- add typed structured memory alongside Markdown;
- add provenance and scope;
- add search as a rebuildable secondary index;
- add lifecycle operations: promote, demote, archive, delete, merge;
- add branch/worktree awareness;
- add review for auto-captured memory;
- add task graph separately from durable knowledge;
- add memory lint rules to prevent bloat.

## Bottom Line

Cline / Roo Memory Bank is the simplest credible architecture for local coding-agent continuity. It should not be copied as the whole system, but it should anchor the human-readable layer. The best future design is probably "Memory Bank plus structure": keep the visible project files, then add typed records, provenance, lifecycle, search, and task/work continuity around them.

