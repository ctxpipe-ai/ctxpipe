# Serena Content Model

Sources: https://github.com/oraios/serena

## What It Stores

Serena primarily stores/project-indexes semantic code intelligence, and secondarily stores project memories. Public materials describe memories as local project-specific notes that agents can list, read, and write.

Likely stored content:

- project conventions;
- architecture notes;
- task context;
- onboarding/discovered facts;
- codebase-specific instructions;
- possibly memories tied to a project activation.

## Semantics / Types It Looks For

Serena's memory semantics are intentionally lightweight and project-scoped. The richer semantics are in code tools:

- symbols;
- references;
- files;
- code structure;
- project activation state.

Memory notes can hold conventions, architecture, and workflow context, but I did not find a public fixed ontology.

## Extraction Prompt

No public extraction prompt was found. Serena exposes memory tools and code-intelligence tools through MCP; agents decide what to write.

Repo: https://github.com/oraios/serena

## How It Manages Memory Soup

Serena avoids some memory soup by making codebase understanding come from semantic code tools rather than stored notes. Instead of remembering every file relationship, the agent can query symbols and references.

Known/likely controls:

- memories are project-scoped;
- tools list/read/write memory explicitly;
- code intelligence reduces pressure to store code facts manually.

Unknown controls:

- memory note schema;
- deduplication;
- pruning;
- confidence/provenance;
- branch awareness.

## Notes For ctxpipe

Serena's lesson is that not all codebase memory should be stored as prose. Some should be re-derived from code intelligence on demand.

