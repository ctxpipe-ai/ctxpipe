# ADR-068: Knowledge retrieval: one hybrid search, Jev judges each layer, disagreements are reasoned at query time

**Status:** Accepted (the CTO, 2026-11-19; the code does not implement it yet; the evals of [ADR-069](ADR-069-knowledge-plane-evals-and-rollout.md) tune it) | **Date:** 2026-11-19 | **Tags:** knowledge, retrieval, search, graph, jev, embeddings, images, mcp

## Context

Today, `get_related` expands the graph with one Cypher query for each hop (`graph-expand.ts`). Then `graph-relevance.ts` ranks the result with these signals:

- static predicate weights;
- confidence and recency decay;
- a hub penalty;
- personalized PageRank;
- MMR.

These signals estimate relevance from the shape of the graph, because the system had no semantic signal ([ADR-051](ADR-051-mcp-read-surface.md) decision 6). Disagreements are only weights, for example `SUPERSEDES` ([ADR-033](ADR-033-graph-ontology-v2.md)).

Jev 1.14 (TypeSafe, through the OpenRouter Decisions endpoint) answers typed questions with probabilities. It takes about 100 ms for a text call. The visual critic uses it ([ADR-063](ADR-063-visual-critic-decides-with-jev.md)).

Disagreement resolution is part of the value of the product. Two items can disagree in part, and only for some questions.

The content and its tables are in [ADR-066](ADR-066-knowledge-content-in-clickhouse.md).

## Decision

1. **One hybrid search for every Workspace size,** so that one test and one eval cover all sizes:
   - **Vectors:** each chunk stores a full vector (about 1024 dimensions, `BFloat16`) and a binary form (1 bit for each dimension). There are two vector spaces (decision 5): a text chunk has a vector of the text model, and an image has a vector of the image model.
   - **Two vector legs.** The question is embedded with both models in parallel. Each space runs stages 1 and 2 below on its own rows. The two legs and the lexical leg go into the same RRF.
   - **Stage 1:** scan the binary vectors of the Workspace's chunks (Hamming distance) and keep the top 500.
   - **Stage 2:** score those 500 again with the full vectors (cosine distance).
   - **One query for both stages.** The chunks table uses `index_granularity = 64`, and the query lets ClickHouse read the full vectors of the 500 rows only (lazy materialization). The file cache uses `boundary_alignment` of 128 KiB. Without these settings, stage 2 read almost all full vectors of the Workspace. Measured on 1 million chunks in one Workspace ([CTX-1391](https://linear.app/ctxpipe/issue/CTX-1391), S3 on the same host): p50 34 ms and p95 45 ms warm, p50 126 ms and p95 209 ms cold. The PoC measures the cold path again on real S3.
   - **Lexical:** the text index selects the chunks that have a query term (`hasAnyTokens`). The score counts the matched terms with one `hasToken` filter for each term (`UNION ALL`, then a count for each chunk), and adds a boost for a title match. A text function in the `SELECT` list reads the full text column (128 MiB on the test corpus), so the score does not use one. The count query read 12 MiB ([CTX-1391](https://linear.app/ctxpipe/issue/CTX-1391)). A cap applies before the score.
   - **Fusion:** RRF (k = 60) gives the top 50 chunks. They are grouped by `active` document.
   - **No ANN vector index.** It filters badly for small Workspaces, and its index must load from S3 for cold parts. If very large Workspaces become too slow, we measure first and then decide.
2. **Jev judges each layer.** One Jev call for each layer asks two yes/no questions for each candidate:
   - **p(answers):** "does this help answer the question?" It gives the final order.
   - **p(explore):** "must the traversal explore from here?" It picks the next frontier.

   Each candidate goes to Jev with its text or image and its metadata: status, source type, dates, validity and confidence. The questions ask only for relevance and for exploration. They do not tell Jev to weigh the metadata ([CTX-1418](https://linear.app/ctxpipe/issue/CTX-1418)). Code applies the status and the validity: the store reads only `active` documents, the layers of `get_related` read only rows that are valid at `validAt` (now by default), a search hit that is not valid at `validAt` (or now) comes after the valid hits, and decision 4 gives the status of each position.
   - The "why" path is the parent chain that the traversal records.
   - The budgets stay in code: depth, fan-out, time and the visited set. `validAt` filters in SQL.
   - PageRank, the intent presets, the predicate weights and MMR go away. No separate ranker runs after the layers.
3. **The tools.**
   - `search_knowledge` is the search plus layer 0.
   - `get_related` is the full loop. Each layer reads the out-relations and in-relations of the frontier in one ClickHouse query.
   - With D = 3, one retrieval is about 6 ClickHouse queries and 5 Jev calls.
4. **Disagreements are reasoned at query time, for each question. Jev gives small facts about the content; code decides** ([CTX-1418](https://linear.app/ctxpipe/issue/CTX-1418), the CTO, 2026-11-19).
   1. Take the top evidence set, about N = 10.
   2. Jev answers yes/no questions (Noul) about the content only. Each question asks for one judgment, and "yes" means that the condition is present:
      - for each pair: do the two items make a claim about the same part of the question; do the claims disagree; does Item a change or replace the claim of Item b (and the reverse);
      - for each item: does its claim apply only to a part of the question, for example one team, one product or one time range.

      The state holds the question and the passages. It does not hold the row data (dates, validity, source authority, stored relations, confidence), because code applies it. The questions go in the pair batches: for N = 10, 4 calls with at most 12 pairs each, in parallel (190 questions). No separate status call.
   3. A pure function in code gives the label of each pair from the facts: unrelated, updates, agrees, partial (they disagree, and the claim of only one item applies to a part) or contradicts. Items that agree form a position.
   4. The same function gives the status of each position (current, superseded, disputed or scoped) from the facts and the row data, with the first rule that decides: a stored `SUPERSEDES`, then Jev's "changes or replaces" in one direction, then the validity at the query time, the source authority, `observed_at` and the confidence. A position that ties with a rival on each rule is disputed. A position whose valid items all apply only to a part of the question is scoped.
   5. Each fact is "yes" at a threshold that is a setting of the loop (`ORCHESTRATOR_DEFAULTS`). The function makes no call, so the evals score a change of a rule or a threshold again from the recorded answers ([ADR-069](ADR-069-knowledge-plane-evals-and-rollout.md) decision 7).
   6. The output is structured positions, with their evidence and the rule that gave the status. The calling agent writes the answer.

   Why: Jev gives one fast judgment for each question, and the questions of one call do not see each other. A typed decision model follows the name of an option, not its definition, and the options of a Choice question compete. Thus a 5-way Choice with long definitions, or a question that weighs four factors, is not reliable. Small facts and rules in code are reliable and can be tested.
5. **Two vector spaces: one for text, one for images** (the CTO, 2026-11-20).
   - Our content is almost all text. A text-only model embeds the text chunks in large batches. A multimodal model embeds only the images, which are few.
   - Each query makes one more embedding call, in parallel with the first. Slow full rebuilds are a larger problem than this call.
   - The reason: Gemini Embedding 2 is the only multimodal model with ZDR endpoints, and its ZDR endpoints take one input for each request. With one space, a full rebuild needs one request for each chunk.
   - The evidence: the live controls of 2026-11-20 ([#892](https://github.com/ctxpipe-ai/ctxpipe/pull/892)). Its Vertex endpoints refused each request with more than one input, also with `zdr: false`. Only Google AI Studio took a batch, and AI Studio has no ZDR endpoint.
   - All embeddings go through the OpenRouter embeddings endpoint, with one OpenAI-compatible client. The models must also be usable outside AWS, for example by a self-hoster on Azure.
   - The model, the pinned provider endpoint and the dimension of each space are config. All of them are part of the projection version ([ADR-067](ADR-067-knowledge-projection-applies-git-diff.md)). Thus a change of model or provider starts a full rebuild, and one space never mixes vectors of two providers.
   - Before a chunk is embedded, it gets one line of context: the title and position of its document.
   - **Text model: Qwen3 Embedding 8B** (`qwen/qwen3-embedding-8b`; the CTO, 2026-11-20). The reasons, from the OpenRouter lists and the public benchmarks of 2026-11-20:
     - It has the best published retrieval quality of the ZDR text models. It had about 70.6 on the MTEB multilingual board at its release in 2025, the first place then. The Qwen3 family has about 69.6 nDCG@10 on MTEB multilingual v2 retrieval, and Gemini Embedding 001 has 67.71 on that measure.
     - OpenAI text-embedding-3-small is a model of 2024. It has 62.3 on the older MTEB English average.
     - It is the least expensive model of good quality: $0.01 for each million tokens.
     - It accepts 32,768 to 40,960 tokens of input, so chunks are not cut.
     - It has three ZDR endpoints (DeepInfra, Nebius and SiliconFlow). Each call pins one of them, with no fallback (decision 7). The other endpoints let us move to a different provider by a config change and a full rebuild. The batch probe of [CTX-1431](https://linear.app/ctxpipe/issue/CTX-1431) chooses the pinned endpoint.
     - Its weights are open, so a self-hoster can run it locally.
     - The disadvantages: the providers are smaller than Azure. The model also expects an instruction line before a query: only the search adds it to the question. The writer embeds the chunks with no instruction line, only with the context line above.
   - **The other text candidates:**
     - Perplexity pplx-embed-v1-4b reports a similar retrieval quality (69.66 nDCG@10, self-reported). It is the challenger in the first eval.
     - OpenAI text-embedding-3-small on Azure is the operational fallback if the Qwen providers fail in operation. It is a change in config with a full rebuild, never a fallback inside a request. It keeps `zdr: true`, `data_collection: "deny"` and a pinned provider.
     - Models with an input limit of 512 tokens are too short for our chunks.
     - Voyage 4, Cohere Embed 5 and NVIDIA Nemotron have no ZDR endpoint.
   - **Image model: Gemini Embedding 2,** pinned to the provider `google-vertex`, one image for each request. It is the only ZDR model that takes images and accepts enough input. Titan Multimodal G1 accepts only 128 tokens of input.
   - Public benchmarks do not match our content (engineering knowledge). The evals of [ADR-069](ADR-069-knowledge-plane-evals-and-rollout.md) decide between the text candidates on our data.
6. **Images.** Jev sees the image bytes, which the backend reads from the Workspace Git at the served SHA ([ADR-066](ADR-066-knowledge-content-in-clickhouse.md) decision 6). OCR or a vision-model description at ingest is optional, and the evals decide it.
7. **Data receivers.** Jev receives the question, the text of the candidates and images. The embedding providers receive the content: the text-model provider receives the text chunks and the questions, and the image-model provider receives the images and the questions. Both are upstreams of OpenRouter, which our public docs list as the model sub-processor, and we reach them only through ZDR endpoints. ADR-063 accepted the Jev endpoint only for public mock screenshots. For customer content:
   - Every Jev call and every embedding call sets `provider.data_collection: "deny"` and `provider.zdr: true`. Our public docs promise ZDR endpoints for hosted model calls. On 2026-11-20, the OpenRouter ZDR list (`GET /api/v1/endpoints/zdr`) had TypeSafe Jev 1.14 (provider `typesafe`), Qwen3 Embedding 8B (`deepinfra/us`, `nebius/bf16` and `siliconflow/fp8`) and Gemini Embedding 2 (`google-vertex/us` and `google-vertex/global`).
   - Every call pins its upstream provider, with no fallback to another provider (OpenRouter `provider.order` with `allow_fallbacks: false`). A call that the pinned provider cannot serve fails. It does not go to another provider.
   - These request settings are the guard. No written confirmation from a provider gates the flag (the CTO, 2026-11-19).
   - ADR-063 decision 6 records that nobody has confirmed that OpenRouter applies these settings on the alpha Decisions endpoint. Before the first org leaves `off`, an automated probe with a real call confirms it. An agent runs the probe, and no person is necessary.

## Consequences

- **Better ranking signal:** the ranking comes from the question, not from the graph shape. We no longer tune the intent presets and the predicate weights.
- **Latency:** about 500 ms of Jev time for `get_related` at D = 3, plus the ClickHouse queries. Each query makes two embedding calls in parallel and two vector scans. The text scan grows with the size of the Workspace: 1 million chunks is about 128 MB of binary vectors for each query. The image scan is small.
- **Cost:** each retrieval has a model cost (Jev and the two query embeddings).
- **Open: what happens when Jev fails or is slow** (return the search order, or fail the call). The PoC decides it.
- **Facts to verify:**
  - how many Jev questions fit in one call (50 candidates × 2, or 12 pairs × 4 and the items);
  - Jev latency with images;
  - the speed of the binary scan from real S3 (the measurements of decision 1 used S3 on the same host).
- **Amends** ADR-051 decision 6 (graph relevance) and section 8 (data layer) for orgs on the new plane. Until the rollout ends, the old ranking serves the other orgs.
