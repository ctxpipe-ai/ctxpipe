# Domain docs

How the engineering skills should consume this repository's domain documentation when exploring the codebase.

## Before exploring, read these

- `AGENTS.md` at the repository root for global instructions.
- `.ai/memory/README.md` for memory structure and loading order.
- `.ai/memory/decisions/` for ADRs relevant to the area being changed.

If any of these files do not exist in a relevant path, proceed without failing and continue with available context.

## File structure

This repository is configured as a single-context setup for engineering skills:

- One root instruction source (`AGENTS.md`)
- One memory system root (`.ai/memory/`)
- Centralised ADRs in `.ai/memory/decisions/`

## Use project vocabulary

When naming domain concepts in issues, designs, or implementation notes, prefer existing project terms from the current docs/memory sources over introducing synonyms.

## Flag decision conflicts

If a proposed change contradicts an existing ADR, call out the conflict explicitly and explain why reopening the decision is justified.
