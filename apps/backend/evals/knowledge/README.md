# Knowledge-plane evals

This harness runs the improvement loop of [ADR-069](../../../../.ai/memory/decisions/ADR-069-knowledge-plane-evals-and-rollout.md) (decisions 5 to 7). It runs one configuration on a dataset and writes a report. The public repository decides the answer, so a fork can run it. The factory gives only the model key, and it runs the harness on the host (`factory eval knowledge:…`, a thin wrapper that comes later).

## The arms

| Arm | Reader | What it is |
| --- | --- | --- |
| `legacy` | `legacyKnowledgeReader` | **The baseline:** the current stack (Postgres search and the FalkorDB graph). |
| `plane` | `planeKnowledgeReader` | The knowledge plane: ClickHouse, the Jev layers and the disagreement step. |

Both arms read through the `KnowledgeReader` seam of the tools (`src/knowledge-reader/`). They get the same Workspaces, the same questions and the same requests (`search_knowledge` with 50 hits, then `get_related` from the seeds with the tool defaults and `includeSeeds`). The run stops before the first question unless both stacks serve the frozen SHA of the corpus. Thus the comparison is fair. The harness adds no retrieval code.

## The dataset

A dataset is one JSON file that `dataset.ts` checks (version 0):

- **Corpora:** the public source, the frozen context repo (URL and SHA), and the id of its Workspace fixture.
- **Questions:** an id, a category of ADR-069 decision 5 (`lookup`, `multi-hop`, `cross-source`, `time`, `disagreement`, `image`, `no-answer`), the text, the gold document paths, the seeds of `get_related` (optional), the expected positions with their status (a `disagreement` question), the key facts, and the split (`dev` to tune, `holdout` for the keep-or-revert decision only).

`fixtures/ctxpipe-memory.dataset.json` holds 12 example questions over `.ai/memory/` of this repository, written by hand. The ADRs with superseded entries are the disagreement questions. `fixtures/ctxpipe-memory.workspace.json` is the small Workspace that the integration test writes to both stacks. The real question set comes from the frozen corpora ([CTX-1393](https://linear.app/ctxpipe/issue/CTX-1393)).

## The metrics

| Level | Metrics |
| --- | --- |
| Component | Search recall@50; the traversal recall of `get_related` (the gold documents that are not seeds). |
| Retrieval | Recall@5 and nDCG@10 of the search; a correct "no answer"; the positions correct (only the plane gives positions). |
| Operations (guards) | p50 and p95 latency of each call; the Jev calls, the Jev questions and the embedding calls of each question; the cost. |
| Agent tasks | Comes later ([CTX-1117](https://linear.app/ctxpipe/issue/CTX-1117)). It reads `answers.jsonl` of a run, or it adds a step to `ask` in `runner.ts`. |

A plane search says "no answer" when no Jev-judged hit reaches the `keepAt` setting. The old stack has no such threshold, so it says "no answer" only when it finds no hit. A search that failed, or that the time budget cut, gets no credit for "no answer".

## Commands

Run each command from `apps/backend`, with the backend environment of the database that holds the eval Workspaces: `DATABASE_URL`, `AUTH_SECRET`, `GRAPH_DB_URI`, `CLICKHOUSE_URL`, and the model settings `MODEL_PROVIDER`, `MODEL_PROVIDER_URL` and `MODEL_PROVIDER_API_KEY` (OpenRouter).

### Run

```sh
bun --env-file=.env.local evals/knowledge/cli.ts run \
  --dataset DATASET.json --targets TARGETS.json --out "$TMPDIR/knowledge-eval/RUN" \
  [--split dev|holdout] [--cap-usd 5] [--set keepAt=0.6] [--kept KEPT/report.json]
```

`TARGETS.json` gives the Workspace of each fixture id in this database:

```json
{ "ctxpipe-memory-v0": { "orgId": "org_…", "orgSlug": "eval", "workspace": "memory" } }
```

Each Workspace must serve the frozen SHA of its corpus on both stacks: the published revision on the old stack, and the last complete knowledge run on the plane (`knowledge_state`).

Write each run folder outside the checkout, as in these examples. The folder holds the org id of the targets file and the corpus text, and this repository is public.

- `--set NAME=VALUE` changes one setting of `ORCHESTRATOR_DEFAULTS` for the run. A run changes one setting (ADR-069 decision 7), so `--set` is allowed one time only.
- `--cap-usd` is the hard spend cap (default $5). Before each model call, the run reserves the worst-case cost of that kind of call: $0.002 for Jev, $0.001 for an embedding, $0.25 for a judge. Each value is above the highest cost that the bake-offs measured. A call that would take the spent and reserved total over the cap does not go out, and the run stops with the spend-cap status in the report. After the call, its real `usage.cost` replaces the reservation. An answer with no cost, or a failed call, keeps the reserved value. Thus calls in parallel never take the run over the cap. The report compares only the questions that both arms answered before the stop, and it lists the others. The spend-capped model key is a second limit, outside the code.
- `--kept` is the report of the last kept run. The report then gives the change of each question against it.

### Score again with no model call

```sh
bun --env-file=.env.local evals/knowledge/cli.ts rescore \
  --from "$TMPDIR/knowledge-eval/RUN" --out "$TMPDIR/knowledge-eval/RUN-keepAt-0.6" \
  --set keepAt=0.6 [--kept KEPT/report.json]
```

`rescore` runs the questions again against the same stores, at the query time of the earlier run. Each model call gets its recorded answer from `calls.jsonl` of the earlier run, in the recorded order, and no call goes out. A setting that needs a call that the recording does not hold (for example a deeper walk) makes that answer incomplete: the report leaves the question out of the metrics and lists it. The cost of a replay is the cost of the recorded calls when they were made. A replay gives no latency.

The disagreement step asks Jev only yes/no facts, and code decides the pair labels and the position status from them (ADR-068 decision 4). Thus a change of that code, or of a fact threshold (`sameAt`, `disagreeAt`, `replacesAt`, `scopedAt`), is scored again with no call.

### Label a draft with the judge panel

```sh
bun --env-file=.env.local evals/knowledge/cli.ts label \
  --draft DRAFT.json --repo CONTEXT-REPO-CLONE --models anthropic/…,openai/…,google/… \
  --out LABELED.json [--cap-usd 5]
```

A model drafts the questions and the labels. The panel then labels each drafted gold document by majority, as in ADR-063: does it answer the question, and what is the status of its claim. Each document of a position gets the status that most models give it. The panel needs three models, each of a different family. Jev is never a judge. The calls go one at a time.

The command reads each document with `git show SHA:PATH` from the clone. It writes the labeled dataset, and each vote to `LABELED.json.votes.json`. These questions are out of the labeled dataset, and the votes file gives the reason: a position document with no majority status (a person decides), or a question that the labels leave invalid (for example no gold document left). When the spend cap stops the command, the output holds the questions and the votes before the stop.

Exit codes: 0 done, 2 bad setup, 3 the spend cap stopped the command.

### Make the public corpora

```sh
GITHUB_TOKEN=… bun evals/knowledge/cli.ts corpus snapshot --plan fixtures/corpora-v0.plan.json --out "$TMPDIR/corpora/snapshots.json"
GITHUB_TOKEN=… bun evals/knowledge/cli.ts corpus issues   --plan fixtures/corpora-v0.plan.json --out "$TMPDIR/corpora/issues.json"
GITHUB_TOKEN=… bun evals/knowledge/cli.ts corpus freeze   --plan fixtures/corpora-v0.plan.json --out DATASET.json
```

The plan (`fixtures/corpora-v0.plan.json`) gives the slice of each source of ADR-069 decision 2: the public repositories at fixed SHAs, the count of issues, and the issue cut-off date. The repositories that the steps make are private, in the org `owner`, with the name prefix `prefix`. `GITHUB_TOKEN` must be able to make and push to them.

1. `snapshot` copies the tree of each repository at its SHA into the private repository `<prefix><corpus>-<repo>`, as one commit with no history. The commit has a fixed author ("ctxpipe evals") and the cut-off date, so it holds no personal data, and the same plan gives the same commit. A repository that holds another commit is refused.
2. The ingest is not a command. In a product org that is only for the evals, make one Workspace for each corpus on the context repo `<prefix><corpus>-context`, and add the snapshot repositories of the corpus as its sources. The current production stack then makes the ingest output (ADR-069 decision 4).
3. `issues` writes the newest issues before the cut-off date of each repository into the context repo, as the production issue mirror writes them (`github/issues/<owner>/<repo>/<n>.md`, with the source file of the snapshot repository in `sources`).
4. `freeze` writes the SHA of the main branch of each context repo into the `corpora` of the dataset file. The questions of the file stay.

### Probe the provider settings

```sh
factory eval knowledge:probe --repo CTXPIPE-CHECKOUT --out "$TMPDIR/knowledge-probe" [--max-cost 0.05]
# or, with the model key in the environment:
bun --env-file=.env.local evals/knowledge/cli.ts probe --out "$TMPDIR/knowledge-probe" [--cap-usd 0.05]
```

Before the first org leaves `off`, this command confirms with real calls that OpenRouter applies the request settings of the knowledge plane (ADR-068 decision 7). Each check sends its request through the real client (`decideNoul`, `embedTexts`), and it records the status, the `provider` field of the answer, and the error text:

| Check | Passes when |
| --- | --- |
| `decisions-zdr-provider` | The Decisions request with our provider block gets HTTP 200 and a yes/no answer, and the answer names a provider of a ZDR endpoint of the Jev model. The probe reads the ZDR list (`GET /api/v1/endpoints/zdr`) at its run. No call pins a provider (ADR-068 decision 7). |
| `decisions-control-without-zdr` | The same request, sent to a Decisions model with no ZDR endpoint (`openai/gpt-6-luna-decisions`) and with `zdr: false`, gets HTTP 200. This shows that the endpoint can serve the request. |
| `decisions-refused-without-zdr-endpoint` | The control request with `zdr: true` gets HTTP 404 with a no-endpoint error. The two requests differ only in `zdr`, so the refusal proves that the Decisions endpoint enforces it. |
| `embedding-query` | A fixed question, with the instruction line of the model, gets one vector of the configured dimension, and the answer names a provider of a ZDR endpoint of the model at an allowed quantization (`bf16`, `fp16`, `fp32` or `unknown`; on 2026-11-20 Nebius and DeepInfra, not SiliconFlow at `fp8`). |
| `embedding-text-batch` | One full batch (`batchSize`, 64) of fixed document chunks in one `embedTexts` call, in the shape that the projection sends, gets one vector of the configured dimension for each chunk in one answer, and the same provider rule. This proves that a ZDR endpoint at an allowed quantization takes a batch. |
| `embedding-control-without-zdr` | The question request of the client, sent to an embedding model with no ZDR endpoint (`openai/text-embedding-ada-002`, with no dimension and no quantizations) and with `zdr: false`, gets HTTP 200. |
| `embedding-refused-without-zdr-endpoint` | The same request with `zdr: true` gets HTTP 404 with a no-endpoint error. This proves that the embeddings endpoint enforces `zdr` with fallback. |

The probe sends only fixed texts (questions and one batch of 64 checkerboard chunks), and the default spend cap is $0.05. An answer names only its provider, not the endpoint: when a provider has more than one endpoint of a model, the name does not show which endpoint served the call. The `zdr` and `quantizations` fields of the request decide the endpoint, and the refusal pairs show that OpenRouter applies `zdr`. When the probe cannot read the ZDR list, the check `zdr-list` fails with the error, and the other checks find no ZDR provider. It writes `probe.json` and `probe.md` to `--out`. It needs no store, but the backend environment check still needs `DATABASE_URL` and `AUTH_SECRET` to be set. Exit codes: 0 all checks pass, 3 the spend cap stopped a call, 4 a check failed. A failed check shows the error of the client, then the error text of the provider. The client error keeps only a complete routing message of OpenRouter (for example "No endpoints found that can handle the requested parameters."), because other error text can echo the input. The probe sends only fixed public inputs, so it also shows the provider text. When a check fails, report it. Do not change the request settings to make it pass.

### Compare the vision models

```sh
factory eval knowledge:vision --repo CTXPIPE-CHECKOUT --out "$TMPDIR/knowledge-vision" [--max-cost 5] [-- --models A,B,C]
# or, with the model key in the environment:
bun --env-file=.env.local evals/knowledge/cli.ts vision --out "$TMPDIR/knowledge-vision" [--models A,B,C] [--cap-usd 5]
```

A vision model reads each image of the knowledge plane and writes its text: a description, the text in the image, and the graph or the sequence of a diagram. Our code renders the Mermaid of the diagram from that reading (`src/knowledge-plane/image-text.ts`). Diagrams are the main feature, so this command compares the candidate models on the diagrams of `fixtures/vision/` (architecture, flow and sequence; see its README). Each model reads each fixture through the production client (`readImage`), and the command scores the reading against the gold graph of the fixture:

| Measure | What it counts |
| --- | --- |
| Node F1 | The nodes, or the participants of a sequence, matched by label. A small reading error still matches (character-pair similarity of 0.75 or more). |
| Edge F1 | The edges between the matched nodes, in the gold direction (either direction for a line with no arrowhead), or the messages of a sequence with their labels. |
| Edge label | The share of the matched edges with the gold label. |
| Group F1, group membership | The groups (clusters, containers, subgraphs) by label, and the share of the matched nodes in the gold group. |
| Direction | The share of the graphs with the gold flow direction. |
| Sequence order | The share of the matched messages in the gold order. |

The report also gives the failed readings, the cost of each image, the median latency, the providers that answered, and the fallback endpoints of each model: the ZDR endpoints that take the JSON schema (`GET /endpoints/zdr`). The request has no provider pin, so OpenRouter can fall back from one of them to another. The default models are `openai/gpt-6.1-terra`, `google/gemini-3.8-flash` and `anthropic/claude-sonnet-5.5`. The command writes `vision.md`, `vision.json` (each reading and its score), and the text of each reading (`<model>/<fixture>.md`) to `--out`. Exit codes: 0 done, 3 the spend cap stopped a call.

## The run folder

| File | Holds |
| --- | --- |
| `manifest.json` | The dataset version, the splits, the query time, the settings, the mode (`live` or `replay`) and the spend. |
| `dataset.json`, `targets.json` | The inputs of the run, so that `rescore` needs only the folder. |
| `answers.jsonl` | The output of each arm for each question: the ranked refs and scores, the positions, the latency, the call counts. |
| `calls.jsonl` | Each Jev and embedding request and its raw answer: the Jev probabilities and the vectors. |
| `report.json`, `report.md` | The report. |

A recorder in front of `fetch` keeps the calls (`model-calls.ts`). Thus the readers stay as they are. The calls hold text of the public corpora only. Never run the harness on customer data.

## The report

The first table compares the plane with the baseline arm, the current stack, for each split and category: the baseline value, the plane value, and the change. Then come the operations guards (with the count of partial answers), the cost, the change of each question against the kept run, the errors, and the questions that the report leaves out.

## Proof

`src/knowledge-reader/knowledge-eval.integration.test.ts` writes the example Workspace to real Postgres, FalkorDB and ClickHouse. It runs the 12 example questions through both arms with fixed model answers (msw), and it checks a small expected report. It then scores a new `keepAt` again from the recorded calls with no model request, it stops a run at the spend cap, and it refuses a Workspace that does not serve the frozen SHA. `src/knowledge-reader/knowledge-eval.test.ts` checks the dataset rules, the metrics, the panel majority and the stop of the panel at the spend cap.
