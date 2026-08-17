# Mem0 Content Model

Sources: https://github.com/mem0ai/mem0/blob/main/mem0/configs/prompts.py, https://github.com/mem0ai/mem0/blob/main/mem0/memory/main.py, https://github.com/mem0ai/mem0/blob/main/LLM.md, https://docs.mem0.ai/

## What It Stores

Mem0 stores extracted memory records derived from messages. Each memory is a concise natural-language statement with metadata, identifiers, hashes, timestamps, embeddings, and optional scope fields such as `user_id`, `agent_id`, and `run_id`.

Current open-source docs/API also support:

- normal user memories;
- agent-scoped memories;
- procedural memories via `memory_type="procedural_memory"`;
- metadata-attached memories;
- entity links and lexical/BM25-support fields in newer extraction paths;
- original message/session records used as context for future extraction.

## Semantics / Types It Looks For

The public prompt file is unusually explicit. The older `FACT_RETRIEVAL_PROMPT` and enhanced user/agent prompts look for:

- personal preferences;
- important personal details such as names, relationships, dates;
- plans and intentions;
- activity and service preferences;
- health and wellness preferences;
- professional details;
- miscellaneous favorites and details.

The newer additive extraction prompt is broader. It extracts from both user and assistant messages, including:

- user facts, preferences, plans, experiences, opinions, and requests;
- assistant recommendations, schedules, plans, solutions, and agreements that the user may later reference;
- transitions and changes;
- motivations and subjective reactions;
- temporally grounded events;
- numerically precise facts;
- proper nouns, titles, places, brands, names, and identifiers.

## Extraction Prompt

Public prompt file: https://github.com/mem0ai/mem0/blob/main/mem0/configs/prompts.py

Key prompt constants found:

- `FACT_RETRIEVAL_PROMPT`;
- `USER_MEMORY_EXTRACTION_PROMPT`;
- `AGENT_MEMORY_EXTRACTION_PROMPT`;
- `DEFAULT_UPDATE_MEMORY_PROMPT`;
- `ADDITIVE_EXTRACTION_PROMPT`;
- `MEMORY_ANSWER_PROMPT`.

Pipeline code showing use of `ADDITIVE_EXTRACTION_PROMPT`: https://github.com/mem0ai/mem0/blob/main/mem0/memory/main.py

Prompt analysis:

- The old prompt is fact/preference-centric and user-personalization-oriented.
- The enhanced user prompt explicitly forbids extracting assistant/system content.
- The agent prompt mirrors this for assistant facts.
- The additive prompt is more sophisticated: it is add-only, uses existing memories only for dedup/linking, grounds relative dates, asks for self-contained memories, preserves specifics, and links related existing memory IDs.

## How It Manages Memory Soup

Mem0 uses several controls:

- related existing memories are retrieved before extraction;
- the extractor skips semantically equivalent memories;
- new memories can link to existing memory IDs;
- memory text hashes deduplicate exact duplicates;
- batch-level deduplication prevents repeated writes from one extraction;
- metadata scopes isolate users, agents, and runs;
- search is filtered by scope;
- entity linking and lexical signals improve retrieval beyond vector similarity;
- custom prompts and `infer=false` let callers control extraction.

The main soup risk is semantic duplication and stale facts. The newer add-only prompt avoids destructive updates, which helps auditability, but means contradiction handling depends on retrieval/linking and later cleanup rather than in-place truth maintenance.

## Notes For ctxpipe

Mem0's prompt is an excellent reference for extraction quality standards: self-contained statements, temporal grounding, specificity preservation, dedup against existing memories, and linked provenance. For ctxpipe, the categories need to shift from personal facts toward repo facts, decisions, task state, corrections, and procedures.

