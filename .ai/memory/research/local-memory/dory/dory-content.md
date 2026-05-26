# Dory Content Model

Sources: https://dory.deeflect.com/, https://pypi.org/project/dory-memory/

## What It Stores

Dory's public site presents memory as a shared markdown corpus. Example file paths include:

- `core/active.md`;
- `decisions/atlas.md`;
- `people/alex.md`;
- `projects/dory/state.md`.

The corpus stores active focus, decisions, people, project state, and any other agent-readable notes. SQLite is a rebuildable index, not the source of truth.

The PyPI package `dory-memory` also describes a typed graph model with nodes such as entity, concept, event, preference, belief, procedure, session, and session summary. I treat that as related public Dory material, but the project identity should be verified before relying on those details.

## Semantics / Types It Looks For

From the site:

- active context;
- decisions;
- people;
- project state;
- linked topics/backlinks;
- canonical pages selected by semantic writes.

From the `dory-memory` package:

- entities;
- concepts;
- events;
- preferences;
- beliefs;
- procedures;
- sessions;
- session summaries;
- typed edges such as preferences, temporal order, support, co-occurrence, and supersession.

## Extraction Prompt

No full extraction prompt was found. Dory exposes `memory-write`, a semantic write verb that auto-routes content to canonical pages, but the routing prompt was not public in search results.

Public site / API description: https://dory.deeflect.com/

## How It Manages Memory Soup

Dory manages soup primarily through information architecture:

- markdown is the editable source of truth;
- hot startup context is bounded through `wake`;
- exact reads use `get` with content hashes;
- search combines BM25 and vector retrieval;
- semantic writes route content to canonical pages instead of appending to a giant log;
- `link` creates graph relationships/backlinks;
- SQLite can be rebuilt from files, so index state cannot become the unreviewable source of truth.

The weak point is write governance: public docs do not show how Dory prevents wrong routing, duplicate canonical pages, or stale notes beyond human editability and backlinks.

## Notes For ctxpipe

Dory is a strong model for "markdown truth, rebuildable index." ctxpipe should consider a similar split, but add explicit file schemas and review rules for auto-routed writes.

