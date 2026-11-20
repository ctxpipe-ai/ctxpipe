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

- **Corpora:** the public source, the frozen context repo (URL, SHA, and the root folder of the Workspace: `root`, with `""` as the default), and the id of its Workspace fixture. The gold paths, the seeds and the position refs are relative to the root, as the tools give the paths of a Workspace.
- **Questions:** an id, a category of ADR-069 decision 5 (`lookup`, `multi-hop`, `cross-source`, `time`, `disagreement`, `image`, `no-answer`), the text, the gold document paths, the seeds of `get_related` (optional), the expected positions with their status (a `disagreement` question), the key facts, and the split (`dev` to tune, `holdout` for the keep-or-revert decision only).

`fixtures/ctxpipe-memory.dataset.json` holds 12 example questions over `.ai/memory/` of this repository, written by hand. Its corpus is this repository at a fixed SHA with the root `.ai/memory`. The ADRs with superseded entries are the disagreement questions. `fixtures/ctxpipe-memory.workspace.json` is the small Workspace that the integration test writes to both stacks. The real question set comes from the frozen corpora ([CTX-1393](https://linear.app/ctxpipe/issue/CTX-1393)).

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

### Hydrate the corpora

```sh
factory eval knowledge:hydrate --repo CTXPIPE-CHECKOUT --out "$TMPDIR/knowledge-eval/hydrate" [--max-cost 5] \
  -- --dataset "$PWD/DATASET.json"
# or, with the model key in the environment:
bun --env-file=.env.local evals/knowledge/cli.ts hydrate \
  --dataset DATASET.json --out "$TMPDIR/knowledge-eval/hydrate" [--cap-usd 5]
```

An eval run repeats only the hydrate and the retrieval (ADR-069 decision 3). `hydrate` writes each frozen context repo of the dataset into both stacks of the database, through the real workflows: `workspace-hydrate` writes the old stack (Postgres and FalkorDB), and it queues `knowledge-projection`, which writes the plane (ClickHouse). It runs these workflows in its own worker, in the OpenWorkflow namespace `knowledge-eval` (`eval-namespace.ts`), so that it never takes the jobs of a real worker. It removes the other jobs that the hydrate queues (the code index and the knowledge maintenance), because the corpus is frozen.

- Each corpus gets one Workspace in the eval org `knowledge-eval` (made-up ids), at the URL, the SHA and the root of the corpus, with the org flag `knowledge_plane` at `shadow`. An org binds one repository to one Workspace, so each corpus has its own context repo. A second hydrate of the same SHA and root makes no model call. A new SHA, URL or root projects both stacks again.
- The hydrate ends when each of its runs is complete, the old stack publishes the SHA with ready embeddings and a ready graph, and the plane serves the SHA.
- The hydrate reads the context repo with no credential: the repository must have an http or https URL and be public (or be on a local Git server). Each Git process of the hydrate runs with no credential of the host: no global or system Git configuration (thus no credential helper), and an empty home folder (thus no `.netrc`).
- `CLICKHOUSE_URL` is the writer user (`ctxpipe_writer`) for `hydrate`, as in the worker, and the reader user (`ctxpipe_reader`) for `run`, as in the backend.
- The model calls are the embedding calls of the two writers, and a vision call for each image of the plane. They go through the recorder of the run, so the spend cap and the ZDR rule apply (see `run`). The recorder keeps no copy of them.
- A failed step of a workflow, or a store of the old stack that the hydrate records as failed, stops the hydrate at once with its error. The workflows retry an outage for minutes, but in an eval a failure is almost always a setup error. Fix it, and run `hydrate` again: it continues from the stored state.

It writes `targets.json` (the input of `run`) to `--out`, and `hydrate.json` (the spend, the calls that got the ZDR block, and the count of `failed` documents of the plane for each corpus) also when it fails. A `failed` document is a file that does not parse, a file type with no converter, or an image that the vision model could not read (ADR-067 decision 8): the plane serves the SHA without it. When the spend cap stopped a call, `hydrate` exits with 3 and writes no targets. Exit codes: 0 done, 1 a step or a store failed (or another error, for example a context repo URL that is not http or https), 2 bad setup, 3 the spend cap stopped a call.

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

Each Workspace must serve the frozen SHA of its corpus on both stacks: the published revision on the old stack, and the last complete knowledge run on the plane (`knowledge_state`). Both stacks must also serve the root of the corpus: a failed projection after a change of the root keeps the earlier projection of the same SHA. `hydrate` makes such Workspaces.

Write each run folder outside the checkout, as in these examples. The folder holds the org id of the targets file and the corpus text, and this repository is public.

- `--set NAME=VALUE` changes one setting of `ORCHESTRATOR_DEFAULTS` for the run. A run changes one setting (ADR-069 decision 7), so `--set` is allowed one time only.
- `--cap-usd` is the hard spend cap (default $5). Before each model call, the run reserves the worst-case cost of that kind of call: $0.002 for Jev, $0.001 for an embedding (or $0.5 for each million UTF-8 bytes of its input, when that is more: a batch of the hydrate holds up to 300,000 bytes), $0.25 for a judge. Each value is above the highest cost that the bake-offs measured. A call that would take the spent and reserved total over the cap does not go out, and the run stops with the spend-cap status in the report. After the call, its real `usage.cost` replaces the reservation. An answer with no cost, or a failed call, keeps the reserved value. Thus calls in parallel never take the run over the cap. The report compares only the questions that both arms answered before the stop, and it lists the others. The spend-capped model key is a second limit, outside the code.
- `--kept` is the report of the last kept run. The report then compares the plane with it for each split and category, gives its guards against the kept guards, and gives the change of each question.
- Each model call goes only to a ZDR endpoint of an allowed provider (ADR-068 decision 7, ADR-070). Each client sends the provider block itself; the recorder does not change a request. A model with no such endpoint refuses the call: it does not fall back.

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
factory eval knowledge:probe --repo CTXPIPE-CHECKOUT --out "$TMPDIR/knowledge-probe" [--max-cost 1] -- \
  --setting MODEL_PROVIDER_ALLOWLIST=SLUGS [--setting MODEL_HIGH_NAME=MODEL ...]
# or, with the model key in the environment:
bun --env-file=.env.local evals/knowledge/cli.ts probe --out "$TMPDIR/knowledge-probe" [--setting NAME=VALUE ...] [--cap-usd 1]
```

Before the first org leaves `off`, this command confirms with real calls that OpenRouter applies the request settings of the knowledge plane (ADR-068 decision 7), and that each model in use answers from a provider of the allowlist (ADR-070). The factory passes no setting but the key. So give each model setting of the hosted stack (factory `machines/hosted`) with `--setting NAME=VALUE`: `MODEL_PROVIDER_ALLOWLIST`, and each `MODEL_*_NAME` that it sets (`MODEL_FAST_NAME`, `MODEL_MEDIUM_NAME`, `MODEL_HIGH_NAME`, `MODEL_EMBEDDING_NAME`, `MODEL_VISION_NAME`). A model name that the hosted stack does not set is the code default on both sides. The probe takes no URL and no key as a setting: the key goes only to the provider that the code names. A setting that is not given comes from the environment. The clients send the allowlist in each request, as production does. Each check of a served answer also needs a provider of the allowlist. Each check sends its request through the real client (`decideNoul`, `embedQuery`, `embedTexts`), and it records the status, the `provider` field of the answer, and the error text:

| Check | Passes when |
| --- | --- |
| `decisions-zdr-provider` | The Decisions request with our provider block gets HTTP 200 and a yes/no answer, and the answer names a provider of a ZDR endpoint of the Jev model. The probe reads the ZDR list (`GET /api/v1/endpoints/zdr`) at its run. No call pins a provider (ADR-068 decision 7). |
| `decisions-control-without-zdr` | The same request, sent to a Decisions model with no ZDR endpoint (`openai/gpt-6-luna-decisions`) and with `zdr: false`, gets HTTP 200. This shows that the endpoint can serve the request. |
| `decisions-refused-without-zdr-endpoint` | The control request with `zdr: true` gets HTTP 404 with a no-endpoint error. The two requests differ only in `zdr`, so the refusal proves that the Decisions endpoint enforces it. |
| `embedding-query` | A fixed question gets one vector of the configured dimension, and the answer names a provider of a ZDR endpoint of the model (on 2026-11-20 only Azure). |
| `embedding-text-batch` | One full batch (`maxBatchInputs`, 2048) of short fixed document chunks in one `embedTexts` call, in the shape that the projection sends, gets one vector of the configured dimension for each chunk in one answer, and the same provider rule. This proves that a ZDR endpoint takes a batch at the input limit of the API. |
| `embedding-control-without-zdr` | The question request of the client, sent to an embedding model with no ZDR endpoint (`openai/text-embedding-ada-002`, with no dimension) and with `zdr: false`, gets HTTP 200. |
| `embedding-refused-without-zdr-endpoint` | The same request with `zdr: true` gets HTTP 404 with a no-endpoint error. This proves that the embeddings endpoint enforces `zdr` with fallback. |
| `vision-read` | The vision client (`readImage`) reads a made-up diagram of the vision eval with the vision model (`MODEL_VISION_NAME`, else its default) and gets HTTP 200. The answer names a provider of a ZDR endpoint of the model. |
| `vision-control-without-zdr` | The vision request of the client, sent to a vision model with no ZDR endpoint (`google/gemini-2.5-flash-lite`) and with `zdr: false`, gets HTTP 200. |
| `vision-refused-without-zdr-endpoint` | The same request with `zdr: true` gets HTTP 404 with a no-endpoint error. This proves that the vision request enforces `zdr`. |
| `chat <model>` | One fixed question through the real chat client (`getModel`) for each chat model in use: the model of each tier (tiers with the same model share one call) and the fixed model of the commit subjects. Each model goes out alone, with no fallback model. It gets HTTP 200 from a provider of the allowlist. |
| `embedding-current-stack` | One fixed question through `generateEmbeddings` (the embedding model of the current stack) gets HTTP 200 and one vector from a provider of the allowlist. |
| `allowlist-control-without-only` | The question request of the plane client, sent to an embedding model whose only ZDR endpoint is outside the allowlist (`qwen/qwen3-embedding-4b`, DeepInfra) with no `only` field, gets HTTP 200 from a provider outside the list. |
| `allowlist-refused-outside-list` | The same request with the allowlist gets HTTP 404 with a no-endpoint error. The two requests differ only in `only`, so this proves that OpenRouter applies the allowlist with ZDR and fallback. |
| `provider-allowlist` | The allowlist is set, and each slug is on the OpenRouter provider list (`GET /api/v1/providers`). The probe maps each slug to the provider name that an answer gives. |

The probe sends only fixed texts (questions and one batch of 2048 checkerboard chunks) and one made-up diagram (`fixtures/vision/order-states.png`), and the default spend cap is $1: the recorder holds $0.05 for each vision call and $0.25 for each chat call in flight. An answer names only its provider, not the endpoint: when a provider has more than one endpoint of a model, the name does not show which endpoint served the call. The `zdr` field of the request decides the endpoint, and the refusal pairs show that OpenRouter applies `zdr`. A ZDR refusal pair sends no `only` field: its control model can be at a trusted provider that the hosted allowlist does not include now, and the allowlist pair proves `only` (ADR-070). When the probe cannot read the ZDR list, the check `zdr-list` fails with the error, and the other checks find no ZDR provider. It writes `probe.json` and `probe.md` to `--out`. It needs no store, but the backend environment check still needs `DATABASE_URL` and `AUTH_SECRET` to be set. Exit codes: 0 all checks pass, 3 the spend cap stopped a call, 4 a check failed. A failed check shows the error of the client, then the error text of the provider. The client error keeps only a complete routing message of OpenRouter (for example "No endpoints found that can handle the requested parameters."), because other error text can echo the input. The probe sends only fixed public inputs, so it also shows the provider text. When a check fails, report it. Do not change the request settings to make it pass.

### Measure the latency of the model calls

```sh
factory eval knowledge:latency --repo CTXPIPE-CHECKOUT --out "$TMPDIR/knowledge-latency" [--max-cost 2] [-- --runs 50]
# or, with the model key in the environment:
bun --env-file=.env.local evals/knowledge/cli.ts latency --out "$TMPDIR/knowledge-latency" [--runs 50] [--cap-usd 2]
```

The time budget of a plane search (`timeBudgetMs`) must fit the latency of its model calls. This command measures them for a decision on the budget. It sends one fixed public question, and one call at a time, so that each latency is the latency of one request. Each call goes only to a ZDR endpoint of a provider of the allowlist (ADR-068 decision 7, ADR-070). It measures only the endpoints of the allowed providers.

| Measure | What it sends |
| --- | --- |
| OpenRouter round trip | A request that reaches no model (10 calls): the network time of this host. |
| Plane query embedding, production request | The query embedding of the real client (`embedQuery`), with no pin, as production sends it: sorted by latency, in one attempt. |
| Plane query embedding, pinned | The same request, pinned to one ZDR endpoint tag of the model (no fallback, one attempt), for each ZDR endpoint. The pin is for the measurement only: production pins no provider. |
| Query embedding, other model | Each other text embedding model with a ZDR endpoint, with no pin, and pinned to each of its ZDR endpoints. |
| Jev, layer judge | The request of the layer judge with 10 made-up candidates (at most 30 calls). |

It writes `latency.md` (for each measure: the calls, the errors, p50, p95, the maximum, the price of 1M input tokens, and the providers that answered) and `latency.json` (each sample) to `--out`. The default spend cap is $2. Exit codes: 0 done, 3 the spend cap stopped a call.

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

The first table compares the plane with the baseline arm, the current stack, for each split and category: the baseline value, the plane value, and the change. Then come the operations guards (with the count of partial answers) and the cost.

With `--kept`, the next section compares the plane with the kept run. It is the input of the keep-or-revert rule of ADR-069 decision 7: a change stays only if the hold-out set improves and no guard gets worse.

- The first table gives the plane metrics now and in the kept run, for each split and category.
- The guard table gives, for each split: the p95 of the search and of `get_related`, the Jev calls and the Jev questions for each question, the cost for each question, and the errors.
- Both tables read only the questions that both runs scored. A replay gives no latency.

Then come the change of each question against the kept run, the errors, and the questions that the report leaves out.

## Proof

`src/knowledge-reader/knowledge-eval-hydrate.integration.test.ts` hydrates a small context repo (real Git over HTTP) into real Postgres, FalkorDB and ClickHouse with `hydrate`, and `run` answers its question on both arms. It checks the ZDR block on each embedding call, a second hydrate with no model call, a new projection when the root changes, the exit code of the spend cap, and the stop at a failed step or a failed store of the old stack. `src/knowledge-reader/knowledge-eval.integration.test.ts` writes the example Workspace to real Postgres, FalkorDB and ClickHouse. It runs the 12 example questions through both arms with fixed model answers (msw), and it checks a small expected report. It then scores a new `keepAt` again from the recorded calls with no model request, it stops a run at the spend cap, and it refuses a Workspace that does not serve the frozen SHA or the root of the corpus on both stacks. `src/knowledge-reader/knowledge-eval.test.ts` checks the dataset rules, the metrics, the panel majority and the stop of the panel at the spend cap.
