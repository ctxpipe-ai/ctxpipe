# Cline / Roo Memory Bank Content Model

Sources: https://docs.cline.bot/prompting/cline-memory-bank, https://docs.cline.bot/prompting/custom-instructions-library/memory-bank, https://github.com/GreatScottyMac/roo-code-memory-bank

## What It Stores

Cline/Roo Memory Bank stores project context in a fixed markdown file hierarchy:

- `projectbrief.md`;
- `productContext.md`;
- `activeContext.md`;
- `systemPatterns.md`;
- `techContext.md`;
- `progress.md`;
- optional additional context files/folders.

Roo variants often add `decisionLog.md` and mode-specific updates.

## Semantics / Types It Looks For

The core files define the ontology:

- project requirements and goals;
- why the project exists;
- problems solved and UX goals;
- current focus;
- recent changes;
- next steps;
- active decisions;
- patterns and preferences;
- architecture and design patterns;
- component relationships;
- implementation paths;
- technologies and setup;
- dependencies and constraints;
- what works;
- what remains;
- known issues;
- evolution of project decisions.

Optional context can include feature docs, integrations, APIs, testing strategy, and deployment procedures.

## Extraction Prompt

The Cline docs publish the full Memory Bank custom instructions.

Prompt link: https://docs.cline.bot/prompting/cline-memory-bank

Prompt analysis:

- The agent is told its memory resets completely and it must rely entirely on the memory bank.
- It must read all memory bank files at the start of every task.
- The files are hierarchical: project brief shapes all other files; context files feed active context and progress.
- Updates happen when discovering patterns, implementing significant changes, on explicit "update memory bank", or when context needs clarification.

## How It Manages Memory Soup

Memory Bank's controls are simple but effective:

- fixed file roles prevent one giant memory file;
- `activeContext.md` is supposed to track current state only;
- `progress.md` summarizes status rather than acting as a detailed log;
- docs recommend keeping files concise;
- details can be split into linked docs;
- `.clineignore` reduces accidental context bloat;
- user-triggered "update memory bank" causes a full review;
- humans can directly edit markdown.

Weaknesses:

- no automatic deduplication;
- no semantic search by default;
- no decay or confidence;
- agents can overfill files unless instructed to keep them lean.

## Notes For ctxpipe

Memory Bank is a strong baseline for file roles. ctxpipe can preserve the clarity of fixed markdown roles while adding structured metadata, task graph state, and search.

