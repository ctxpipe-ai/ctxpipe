# Basic Memory Content Model

Sources: https://github.com/basicmachines-co/basic-memory, https://docs.basicmemory.com/, https://github.com/basicmachines-co/basic-memory-skills, https://github.com/basicmachines-co/basic-memory/blob/main/src/basic_memory/mcp/resources/ai_assistant_guide.md

## What It Stores

Basic Memory stores a local markdown knowledge graph. Files become entities, and each entity can contain:

- YAML/frontmatter metadata;
- title;
- entity type;
- permalink;
- tags or other metadata;
- observations;
- relations;
- arbitrary markdown body content.

It can also support typed task notes, schemas, research notes, daily/reflection notes, and other structured note types through skills and schema validation.

## Semantics / Types It Looks For

The core semantic primitives are:

- entities;
- observations;
- relations.

Observations are markdown list items with categories. Public examples include:

- method;
- tip;
- preference;
- fact;
- experiment;
- resource;
- question;
- note;
- requirement;
- decision.

Relations are typed links between entities, such as `relates_to`, `requires`, `implements`, `part_of`, `includes`, `inspired_by`, and similar user-defined relation types.

The `basic-memory-skills` repository expands the content model into:

- tasks;
- schemas;
- reflection outputs;
- note hygiene;
- metadata search;
- defragmentation;
- lifecycle/archive state;
- ingestion outputs;
- research entities.

## Extraction Prompt

Basic Memory itself does not expose a single universal extraction prompt in the same way Mem0 does. Instead it exposes MCP tools and human/agent instructions for writing well-structured notes.

Prompt/instruction links:

- AI assistant guide with write examples: https://github.com/basicmachines-co/basic-memory/blob/main/src/basic_memory/mcp/resources/ai_assistant_guide.md
- Skills with memory-writing instructions: https://github.com/basicmachines-co/basic-memory-skills
- Core format docs in README: https://github.com/basicmachines-co/basic-memory

Prompt analysis:

- The agent is expected to intentionally write notes and relations, not passively extract every fact.
- The note format itself is the extraction schema: entity file plus categorized observations and typed wiki-link relations.
- Skills act as modular prompts for task memory, reflection, defrag, schema lifecycle, and ingestion.

## How It Manages Memory Soup

Basic Memory's anti-soup controls:

- markdown files remain human-editable;
- observations are typed/categorized;
- relations make connections explicit;
- each entity has a permalink;
- SQLite/database index is derived and rebuildable;
- graph traversal (`build_context`) retrieves bounded related context;
- schema validation can enforce note shapes;
- defrag skills split bloated files, merge duplicates, remove stale information, and restructure hierarchy;
- lifecycle skills archive completed work rather than deleting it silently;
- metadata search lets agents filter by status, priority, confidence, or custom fields.

The risk is that agents can still write poor observations or overstuff entity files unless skills and periodic defrag are used.

## Notes For ctxpipe

Basic Memory's strongest lesson is that a plain markdown knowledge base can still have graph semantics if observations and relations are first-class. This is a good fit for durable repo knowledge and ADR-like memory.

