# Serena Deep Dive

Research date: 2026-05-24

## Sources

- GitHub repository: https://github.com/oraios/serena
- README: https://github.com/oraios/serena/blob/main/README.md
- User guide: https://oraios.github.io/serena/
- Memories docs: https://github.com/oraios/serena/blob/main/docs/02-usage/045_memories.md
- Workflow docs: https://github.com/oraios/serena/blob/main/docs/02-usage/040_workflow.md
- DeepWiki memory management summary: https://deepwiki.com/oraios/serena/5.2-symbol-and-code-analysis-tools
- DeepWiki architecture summary: https://deepwiki.com/oraios/serena/3-system-architecture
- Local prior research: [details](./serena-details.md), [content](./serena-content.md), [sentiment](./serena-sentiment.md)

## Executive Read

Serena is not primarily a memory system. It is a local MCP coding toolkit that gives agents IDE-like semantic code retrieval, editing, and refactoring. Its memory feature is simple Markdown notes stored per project and optionally globally. The important insight is that codebase memory should not all be prose. A coding agent should be able to re-derive many facts from symbols, references, diagnostics, and code structure.

Serena's memory system is lightweight, but better designed than it first appears: project-local Markdown, global memories, `mem:` references, read-only patterns, ignored patterns, dashboard editing, CLI checks, onboarding, and a seeded `memory_maintenance` convention file.

For ctxpipe, Serena is the strongest reminder that durable memory and live code intelligence should be paired. Store conventions, architecture, and decisions; derive symbols, callers, references, and file structure from code on demand.

## What It Is

Serena describes itself as "the IDE for your coding agent". It provides:

- semantic code retrieval;
- symbol-level navigation;
- editing and refactoring tools;
- MCP integration;
- Agno integration;
- optional JetBrains plugin backend;
- language-server backend;
- project activation workflow;
- onboarding;
- memory management.

Primary category: coding-agent semantic tooling.

Secondary category: project memory.

It supports many MCP clients:

- Claude Code;
- Codex;
- OpenCode;
- Gemini CLI;
- VS Code;
- Cursor;
- JetBrains IDE assistants;
- Claude Desktop;
- Codex app;
- OpenWebUI;
- other MCP clients.

## Implementation And Language

Repository: https://github.com/oraios/serena

Observed repo properties during research:

- primary language: Python;
- GitHub language breakdown surfaced as about 90 percent Python;
- license: MIT;
- installation via `uv`;
- package command: `serena`;
- MCP server can be launched by client or run in HTTP/SSE mode;
- latest visible release during this research pass: v1.5.1 on May 18, 2026;
- very high public star count and active repository.

Backends:

- default: language servers implementing LSP;
- alternative: Serena JetBrains Plugin, paid/free trial, using JetBrains IDE analysis.

Language support:

- README lists over 40 languages with the language-server backend, including JavaScript, TypeScript, Python, Go, Rust, Java, C/C++, Ruby, PHP, Swift, Kotlin, Scala, Lua, Nix, Solidity, Svelte, YAML, and many others.

## High-Level Architecture

Serena has several layers:

1. Project activation
2. Contexts and modes
3. Semantic code tools
4. Memory tools
5. Optional dashboard/CLI support

### Project Activation

Serena operates against an active project. A project can be provided at MCP startup or activated during conversation if the relevant tool is available.

Activation tells the agent:

- which project is active;
- what memories exist;
- what tools/context/modes apply.

### Contexts

Contexts tune Serena for environments:

- desktop app;
- agent;
- IDE assistant;
- Claude Code/single-project contexts according to docs.

Context is set at startup and shapes tool availability and prompts.

### Modes

Modes tune behavior:

- planning;
- editing;
- interactive;
- one-shot;
- no-onboarding;
- no-memories.

Modes can be composed, though docs caution that some combinations can be semantically incompatible.

### Semantic Code Tools

Serena's main retrieval/editing value comes from symbolic understanding:

- find symbols;
- overview symbols in a file;
- find referencing symbols;
- find declaration;
- find implementations where supported;
- replace symbol body;
- insert before/after symbol;
- rename symbols;
- move symbols/files/directories where backend supports;
- diagnostics and inspections depending on backend;
- regex/project search fallback;
- file/directory utilities;
- shell/test execution if enabled.

This reduces reliance on storing code relationships as memory.

## Memory Storage Model

Serena memories are Markdown files.

Project-specific memories:

```text
.serena/memories/
```

Global memories:

```text
~/.serena/memories/global/
```

Memory names map to paths. For example:

```text
overview                  -> .serena/memories/overview.md
auth/login/logic          -> .serena/memories/auth/login/logic.md
architecture              -> .serena/memories/architecture.md
global/preferences        -> ~/.serena/memories/global/preferences.md
```

Storage properties:

- Markdown;
- UTF-8;
- nested names can create subdirectories;
- user and agent can edit;
- dashboard can edit while Serena is running;
- CLI can manage/check memories;
- project memory can be git-tracked if desired;
- global memory can be git-tracked separately by the user.

## Memory Content Model

Serena stores lightweight project notes:

- project overview;
- architecture notes;
- conventions;
- build/test commands;
- task context;
- codebase onboarding notes;
- workflow preferences;
- relevant module explanations;
- memory maintenance conventions;
- global user/team conventions if configured.

The fixed ontology is intentionally light. The richer "memory" of code structure is handled by code tools:

- symbols;
- references;
- declarations;
- implementations;
- files;
- diagnostics;
- refactorings.

This is an important distinction:

- durable Markdown memory should store human-level guidance and stable discoveries;
- live code intelligence should answer facts that can be derived from the current code.

## Examples Of Memories It Stores

Example `overview.md`:

```markdown
# Project Overview

This repo is a TypeScript monorepo with backend, UI, docs, and codesearch apps. Development runs from the repo root with pnpm. The backend uses Hono, Drizzle, Better Auth, and evlog.
```

Example `suggested_commands.md`:

```markdown
# Suggested Commands

- Run backend tests: `pnpm --filter @ctxpipe/backend test`
- Run UI tests: `pnpm --filter @ctxpipe/ui test`
- Run migrations: `pnpm db:migrate`
- Start host dev: `pnpm dev`
```

Example `architecture.md`:

```markdown
# Architecture

GitHub and Forge integrations use the unified `connections` table. Prefer `connectionId` or repo-scoped resolution over one-install-per-org assumptions.
```

Example `auth/login/logic.md`:

```markdown
# Auth Login Logic

Login routes use Better Auth. Avoid bypassing Better Auth session handling. When adding organization-aware auth, follow the local Better Auth organization instructions.

Related: `mem:architecture`
```

## Memory References

Serena has a useful memory-reference convention:

```markdown
Related: `mem:auth/login/logic`
```

Documented behavior:

- memories may reference each other with `mem:NAME`;
- rename/move can rewrite references;
- integrity checks can report stale references;
- fuzzy near-miss checks can be enabled;
- auto-prefix references command can rewrite bare references with `mem:`.

This is a small but meaningful anti-soup feature. It makes Markdown memories a lightweight graph without requiring a graph database.

## Onboarding And Extraction

Serena performs onboarding when it sees a project with no memories.

Documented onboarding flow:

1. Project activation checks whether memories exist.
2. If none exist, onboarding triggers.
3. Serena reads key files and directories to understand project structure.
4. Before writing project memories, Serena materializes a project-local `memory_maintenance` memory.
5. Agent is instructed to read `memory_maintenance`.
6. Gathered information is written into project memories following onboarding instructions and memory conventions.

The `memory_maintenance` memory contains:

- dense agent-notes style;
- `mem:` reference convention;
- reference model around core memories;
- add/update threshold;
- maintenance actions such as rename, delete, split.

Prompt availability:

- public docs describe the onboarding behavior and conventions;
- I did not find a single full extraction prompt equivalent to Cline's Memory Bank custom instructions in this pass;
- the `memory_maintenance` template appears to be shipped in the package/repo and should be inspected directly before implementation borrowing.

## Retrieval And Use Path

Serena retrieval has two complementary paths.

### Memory Retrieval

On project activation:

- the agent receives a list of available memories;
- it is told to read memories when appropriate;
- appropriateness is inferred from memory names;
- user can instruct agent to update memories.

Tools include:

- list memories;
- read memory;
- write memory;
- delete memory;
- rename memory;
- CLI check commands.

### Code Retrieval

For code facts, Serena expects the agent to use semantic tools:

- find symbol;
- find references;
- get file symbol overview;
- query declarations/implementations;
- edit symbols directly;
- inspect diagnostics/tests.

This is the key design move. The agent does not need a memory note saying "function X calls Y" when an LSP can answer that against the current code.

## Memory Soup Controls

Serena has more controls than a naive Markdown memory system:

- project-specific memory directory;
- global memory directory;
- memory names as paths;
- `mem:` references;
- rename rewriting for references;
- integrity check command;
- auto-prefix command;
- read-only memory patterns;
- ignored memory patterns;
- dashboard/manual editing;
- no-overwrite behavior for seeded `memory_maintenance`;
- onboarding can be disabled;
- all memory tools can be disabled with `no-memories`;
- archived memories can be hidden with ignore patterns.

Limitations:

- no semantic memory search described;
- no confidence scoring;
- no TTL/decay;
- no automatic dedupe beyond conventions;
- no provenance per memory entry;
- no branch/worktree scope surfaced;
- no typed memory categories beyond names/conventions;
- no review queue for agent-written notes.

Serena's best soup control is actually external to memory: semantic code retrieval reduces the need to store code facts as prose.

## Architecture Choices

### Code Intelligence Before Prose Memory

Benefits:

- code facts stay fresh;
- fewer stale notes;
- lower token use for large files;
- better refactoring reliability;
- less manual documentation burden.

Costs:

- depends on language server quality;
- setup varies by language;
- untyped/dynamic code is harder;
- code tools do not remember rationale.

### Markdown Memories

Benefits:

- local;
- human-readable;
- manually editable;
- project-scoped;
- git-friendly.

Costs:

- no advanced retrieval;
- no lifecycle metadata;
- depends on agent naming discipline.

### Onboarding

Benefits:

- first session builds a project map;
- future sessions avoid re-reading everything;
- memory conventions are seeded.

Costs:

- onboarding can consume large context;
- generated memories need review;
- failed LLM onboarding can leave missing or partial files.

### Contexts And Modes

Benefits:

- same server can fit desktop, IDE, autonomous, planning, editing;
- tool surface can be tuned;
- memory/onboarding can be disabled.

Costs:

- configuration can be confusing;
- incompatible mode combinations are possible;
- more concepts for users to learn.

## Benchmarks And Evidence

Memory-specific benchmarks: none found.

Code-tool evidence:

- README includes agent evaluation/testimonial-style results from Opus/GPT/Copilot CLI on coding tasks;
- Serena claims semantic tools make agents faster and more reliable, especially in larger codebases;
- repository adoption is very high;
- sentiment in coding-agent circles is positive for semantic navigation.

Interpretation:

- Serena should not be evaluated as a dedicated memory benchmark competitor.
- Its value is code-intelligence augmentation plus lightweight notes.
- It is evidence that "memory" for codebases includes retrievable live structure, not only stored facts.

## Sentiment

Public sentiment is positive adjacent signal:

- people like local MCP code intelligence;
- people want agents to use symbol/reference tools rather than fragile text operations;
- memory itself is discussed less than the semantic tooling;
- setup/language-server variance is the main caution.

Confidence: medium-low for memory-specific sentiment, higher for coding-tool sentiment.

## Pros

- Strong coding-agent fit.
- Open source, MIT.
- Local-first.
- Very broad language support through LSP.
- MCP-compatible with many clients.
- Project memories are simple Markdown.
- Global memories exist for cross-project guidance.
- `mem:` references and integrity checks are excellent small features.
- Read-only and ignored memory patterns help control agent behavior.
- Onboarding creates useful first memories.
- Semantic code tools reduce stale prose memory.
- Can disable memory if another system is preferred.

## Cons

- Memory is secondary, not a full lifecycle system.
- No advanced memory retrieval/ranking surfaced.
- No decay/TTL/confidence/provenance.
- Onboarding output quality depends on LLM.
- Language server setup can vary by stack.
- JetBrains backend is paid for richer capabilities.
- Tool name collisions and MCP setup issues are documented concerns.
- Shell/editing tools require safety review.
- Not focused on task/work graph continuity.

## Gaps And Missing Facets

Missing for a complete coding memory system:

- typed decisions/patterns/errors/constraints;
- durable checkpoints;
- task graph;
- progress logs;
- per-memory provenance;
- source file/commit links;
- confidence and review status;
- semantic memory search;
- staleness detection;
- auto-archive;
- branch/worktree awareness;
- secret redaction;
- extraction prompt audit;
- multi-user conflict model.

Areas to inspect further:

- shipped `memory_maintenance` template;
- exact memory tool schemas;
- dashboard memory UI behavior;
- read-only/ignored pattern config;
- how global memory is protected in teams;
- how onboarding chooses which files to read.

## Fit For Individuals

Excellent as a companion coding tool. Good as a light memory layer.

Best individual use cases:

- large codebase navigation;
- symbol-aware edits/refactors;
- onboarding a coding agent to a repo;
- storing project conventions and commands;
- reducing brittle grep-based workflows.

Less ideal if:

- the main need is durable task state;
- the user wants automatic capture;
- the user needs cross-session semantic memory search.

## Fit For Teams

Good as a shared tool, but memory governance is light.

Team strengths:

- project memories can live in repo;
- memory conventions can be shared;
- global memory can be git-tracked separately;
- read-only patterns can protect shared memories;
- code tools provide shared accurate code understanding.

Team risks:

- global memories are not project-versioned by default;
- no built-in review workflow for memory changes;
- no task ownership/dependency model;
- no ACL surfaced beyond config patterns.

## Security And Privacy

Positive:

- local operation;
- MIT source;
- project-local Markdown memories;
- global memory can be protected with read-only patterns;
- memory can be disabled;
- read-only mode can disable editing tools;
- ignored patterns can hide archived memories.

Risks:

- shell tool can run arbitrary commands if enabled;
- generated memories can include secrets if onboarding reads sensitive files;
- global memory might leak project-specific facts if misused;
- JetBrains/backend modes may have different data boundaries;
- memory files may be committed accidentally.

Recommended mitigation:

- use read-only mode for analysis-only sessions;
- review onboarding output;
- configure ignored/read-only patterns;
- keep secrets out of memories;
- commit project memories intentionally;
- disable shell/editing tools where unnecessary.

## Design Lessons For ctxpipe

High-value ideas to copy:

- separate stored memories from live code intelligence;
- project-local Markdown memories;
- global memories for user/team conventions;
- memory names as paths;
- explicit memory reference syntax;
- reference integrity checks;
- ignored memory patterns;
- read-only memory patterns;
- onboarding that writes memories but asks for review;
- disable memory mode;
- use LSP/symbol search instead of storing code facts as text.

Ideas to add:

- typed durable memory categories;
- task/checkpoint/progress layer;
- provenance and source links;
- review/promotion pipeline;
- branch/worktree scope;
- search index over memories;
- freshness/confidence metadata.

## Bottom Line

Serena should not be copied as the whole memory architecture. It should be paired with one. Its core lesson is crucial: a coding-agent memory system should not try to remember the current codebase as prose. Store stable decisions, conventions, and rationale; use semantic code tools to answer live structural questions from the actual code.

