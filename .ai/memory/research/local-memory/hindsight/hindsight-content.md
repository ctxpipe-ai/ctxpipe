# Hindsight Content Model

Sources: https://github.com/vectorize-io/hindsight, https://github.com/hindsight-ai/hindsight-ai, https://hindsight.vectorize.io/blog/2026/04/08/adding-memory-to-codex-with-hindsight, https://hindsight.vectorize.io/blog/2026/03/06/adding-memory-to-openclaw-with-hindsight, https://github.com/hindsight-ai/hindsight-ai

## What It Stores

Hindsight stores memories as durable blocks that can be retrieved, consolidated, and scored. Public materials describe:

- raw interaction-derived memories;
- memory blocks;
- facts and entities extracted from conversations;
- lessons learned;
- keywords;
- feedback on memory usefulness/correctness;
- conversation IDs and agent IDs;
- consolidation suggestions;
- archived/deleted memory state.

The `hindsight-ai/hindsight-ai` README names a `MemoryBlock` model with `content`, `lessons_learned`, and `keywords`, plus feedback scores and feedback logs.

## Semantics / Types It Looks For

Hindsight focuses on operational learning:

- facts;
- entities;
- lessons learned;
- user feedback;
- successful/failed behavior patterns;
- memories relevant to future task performance;
- coding-session knowledge captured from transcripts.

The Codex integration strips injected memory tags before retain to prevent feedback loops, then sends session transcripts for extraction.

## Extraction Prompt

I found descriptions of the extraction and consolidation process, but not a full extractor prompt body.

Relevant links:

- Codex integration: https://hindsight.vectorize.io/blog/2026/04/08/adding-memory-to-codex-with-hindsight
- OpenClaw integration: https://hindsight.vectorize.io/blog/2026/03/06/adding-memory-to-openclaw-with-hindsight
- consolidation worker description: https://github.com/hindsight-ai/hindsight-ai

The older `hindsight-ai/hindsight-ai` README says consolidation uses an LLM to identify semantically similar or duplicate memory blocks, group them, and generate consolidated content, lessons learned, and keywords with strict JSON output.

## How It Manages Memory Soup

Hindsight's anti-soup model is centered on consolidation and feedback:

- background workers consolidate similar/duplicate memory blocks;
- LLM grouping creates denser consolidated suggestions;
- suggestions are stored as pending for review rather than blindly overwriting;
- TF-IDF/cosine fallback can identify similar groups if the LLM is unavailable;
- feedback scores track whether memories helped or hurt;
- integrations remove injected memory tags before retention to avoid recursive memory pollution;
- explicit retrieve/report-feedback tools make memory interactions observable.

The main open question is how aggressively extraction filters routine or low-value interactions in the current Vectorize implementation; public blog posts describe extraction but not the full prompt.

## Notes For ctxpipe

Hindsight is a strong reference for feedback-aware memory. ctxpipe should store user corrections and memory usefulness signals, not just "facts."

