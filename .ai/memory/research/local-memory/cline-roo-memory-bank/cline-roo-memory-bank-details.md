# Cline / Roo Memory Bank Details

Sources: https://docs.cline.bot/features/slash-commands/workflows, https://docs.cline.bot/prompting/custom-instructions-library/memory-bank, https://github.com/GreatScottyMac/roo-code-memory-bank, https://www.reddit.com/r/RooCode/comments/1ivbtvw/finally_managed_to_create_the_memory_bank_i_was/

## Snapshot

Cline Memory Bank and Roo Code Memory Bank are markdown-based project memory patterns for coding agents. They use structured files such as project brief, product context, active context, system patterns, tech context, and progress to restore agent continuity after context resets.

Status: not one single product. Cline publishes a Memory Bank custom-instructions workflow. Roo Code has community memory-bank implementations and modes.

## How It Works

The core pattern:

- the agent treats memory files as source of truth;
- at task start, it reads required memory files;
- during work, it updates active context/progress/decision files;
- if context resets, the new agent reconstructs the project from the files.

Common file set:

- `projectbrief.md`;
- `productContext.md`;
- `activeContext.md`;
- `systemPatterns.md`;
- `techContext.md`;
- `progress.md`.

Some variants add modes such as architect/code/ask/debug and command workflows for initialization, update, and task completion.

## Storage And Data Model

Plain markdown under a project directory. The data model is a manually maintained documentation hierarchy rather than a database. Retrieval is explicit reading, not semantic search by default.

## Integrations

First-class with Cline/Roo through custom instructions, workflows, and modes. The pattern can be reused by Claude Code, Codex, Cursor, and any file-reading agent.

## Selling Points

- No daemon, no database, no vendor.
- Highly inspectable and editable.
- Easy to git commit/review.
- Works even when the agent has no MCP support.
- Solves context-window reset pain well enough for many users.

## Open/Closed Source And Target Users

Open-source/pattern: yes. Community repos are public; Cline docs are public.

Target users: individual developers and small teams wanting a low-tech memory layer. It is less suitable when many agents write concurrently or when semantic retrieval across a large corpus is needed.

## Risks And Unknowns

- Agents can over-edit memory files or produce verbose stale summaries.
- Manual read/update discipline is required.
- No built-in search, decay, audit, schema validation, or conflict resolution.
- The pattern can accumulate duplicated facts across files.

