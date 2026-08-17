# memd Content Model

Sources: https://memd.dev/

## What It Stores

memd stores several explicit classes of coding-agent memory:

- context entries;
- decisions;
- patterns;
- errors;
- schemas;
- constraints;
- solutions;
- checkpoints;
- progress logs;
- sessions;
- persistent tasks.

Each context entry can include type, priority, scope, tags, and TTL. Checkpoints store completed steps, blockers, and next actions. Progress logs form an append-only audit trail of actions, changed files, outcomes, and notes. Tasks include status lifecycle, priority, and dependency/blocker semantics.

## Semantics / Types It Looks For

The public site says there are ten entry types. It explicitly names:

- decision;
- pattern;
- error;
- schema;
- constraint;
- solution;
- context-like entries;
- checkpoints;
- progress/session logs;
- tasks.

The model is coding-workflow-oriented: remember what was decided, what went wrong, what schema/constraints govern implementation, what solution worked, and where the task stopped.

## Extraction Prompt

I did not find a public extraction prompt. memd exposes typed MCP tools, so agents likely decide what to store through tool descriptions and local agent instructions rather than a single visible LLM extractor.

Public API/tool surface: https://memd.dev/

## How It Manages Memory Soup

memd's anti-soup mechanisms are structural:

- memory entries are typed;
- tags and scope segment storage;
- priority affects retention;
- TTL-based expiry sweeps stale entries;
- critical/high-priority knowledge is protected from auto-removal;
- SQL filters run alongside vector similarity search;
- checkpoints separate resumable task state from durable knowledge;
- progress logs preserve raw action history without polluting distilled entries;
- tasks have status and dependency blocking.

The main unknown is extraction quality: if agents write poor entries, the structured schema helps but does not solve noisy or duplicated content by itself.

## Notes For ctxpipe

memd's schema is close to a useful coding-agent memory ontology: decisions, patterns, errors, schemas, constraints, solutions, checkpoints, progress, sessions, and tasks. The TTL/priority combination is worth copying.

