# Knowledge-plane evals

This harness runs the improvement loop of [ADR-069](../../../../.ai/memory/decisions/ADR-069-knowledge-plane-evals-and-rollout.md) (decisions 5 to 7). It runs one configuration on a dataset and writes a report. The public repository decides the answer, so a fork can run it. The factory gives only the model key, and it runs the harness on the host (`factory eval knowledge:…`, a thin wrapper that comes later).

## The arms

| Arm | Reader | What it is |
| --- | --- | --- |
| `legacy` | `legacyKnowledgeReader` | **The baseline:** the current stack (Postgres search and the FalkorDB graph). |
| `plane` | `planeKnowledgeReader` | The knowledge plane: ClickHouse, the Jev layers and the disagreement step. |

Both arms read through the `KnowledgeReader` seam of the tools (`src/knowledge-reader/`). They get the same Workspaces, the same questions and the same requests (`search_knowledge` with 50 hits, then `get_related` from the seeds with the tool defaults and `includeSeeds`). Thus the comparison is fair. The harness adds no retrieval code.

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
| Operations (guards) | p50 and p95 latency of each call; the Jev calls and the embedding calls of each question; the cost. |
| Agent tasks | Comes later ([CTX-1117](https://linear.app/ctxpipe/issue/CTX-1117)). It reads `answers.jsonl` of a run, or it adds a step to `ask` in `runner.ts`. |

A plane search says "no answer" when no Jev-judged hit reaches the `keepAt` setting. The old stack has no such threshold, so it says "no answer" only when it finds no hit.

## Commands

Run each command from `apps/backend`, with the backend environment of the database that holds the eval Workspaces: `DATABASE_URL`, `AUTH_SECRET`, `GRAPH_DB_URI`, `CLICKHOUSE_URL`, and the model settings `MODEL_PROVIDER`, `MODEL_PROVIDER_URL` and `MODEL_PROVIDER_API_KEY` (OpenRouter).

### Run

```sh
bun --env-file=.env.local evals/knowledge/cli.ts run \
  --dataset DATASET.json --targets TARGETS.json --out runs/RUN \
  [--split dev|holdout] [--cap-usd 5] [--set keepAt=0.6] [--kept runs/KEPT/report.json]
```

`TARGETS.json` gives the Workspace of each fixture id in this database:

```json
{ "ctxpipe-memory-v0": { "orgId": "org_…", "orgSlug": "eval", "workspace": "memory" } }
```

Each Workspace must be ready on both stacks: a published revision on the old stack, and a complete knowledge run on the plane (`knowledge_state`).

- `--set NAME=VALUE` changes one setting of `ORCHESTRATOR_DEFAULTS` for the run. A run changes one setting (ADR-069 decision 7). You can give `--set` more than one time.
- `--cap-usd` is the spend cap (default $5). The run stops before the first model call after the cap, and the report holds the answers before the stop. A model answer with no cost counts at an upper estimate, so a missing cost never turns the cap off.
- `--kept` is the report of the last kept run. The report then gives the change of each question against it.

### Score again with no model call

```sh
bun --env-file=.env.local evals/knowledge/cli.ts rescore \
  --from runs/RUN --out runs/RUN-keepAt-0.6 --set keepAt=0.6 [--kept runs/KEPT/report.json]
```

`rescore` runs the questions again against the same stores. Each model call gets its recorded answer from `calls.jsonl` of the earlier run, and no call goes out. A setting that needs a call that the recording does not hold (for example a deeper walk) makes that answer incomplete: the report lists it and leaves it out of the metrics.

### Label a draft with the judge panel

```sh
bun --env-file=.env.local evals/knowledge/cli.ts label \
  --draft DRAFT.json --repo CONTEXT-REPO-CLONE --models anthropic/…,openai/…,google/… \
  --out LABELED.json [--cap-usd 5]
```

A model drafts the questions and the labels. The panel then labels each drafted gold document by majority, as in ADR-063: does it answer the question, and what is the status of its claim. The panel needs an odd number of models, at least three, each of a different family. Jev is never a judge. The command reads each document with `git show SHA:PATH` from the clone. It writes the labeled dataset, and each vote to `LABELED.json.votes.json`. A question that the labels leave invalid (for example no gold document left) is out of the labeled dataset, and the votes file names it.

Exit codes: 0 done, 2 bad setup, 3 the spend cap stopped the command.

## The run folder

| File | Holds |
| --- | --- |
| `manifest.json` | The dataset version, the arms, the splits, the query time, the settings, the mode (`live` or `replay`) and the spend. |
| `dataset.json`, `targets.json` | The inputs of the run, so that `rescore` needs only the folder. |
| `answers.jsonl` | The output of each arm for each question: the ranked refs and scores, the positions, the latency, the call counts. |
| `calls.jsonl` | Each model request and its raw answer: the Jev probabilities, the embedding vectors, the panel replies. |
| `report.json`, `report.md` | The report. |

A recorder in front of `fetch` keeps the calls (`model-calls.ts`). Thus the readers stay as they are. The calls hold text of the public corpora only. Never run the harness on customer data.

## The report

The first table compares the plane with the baseline arm, the current stack, for each split and category: the baseline value, the plane value, and the change. Then come the operations guards, the cost, the change of each question against the kept run, the errors, and the incomplete answers.

## Proof

`src/knowledge-reader/knowledge-eval.integration.test.ts` writes the example Workspace to real Postgres, FalkorDB and ClickHouse. It runs the 12 example questions through both arms with fixed model answers (msw), and it checks a small expected report. It then scores a new `keepAt` again from the recorded calls with no model request, and it stops a run at the spend cap. `src/knowledge-reader/knowledge-eval.test.ts` checks the dataset rules, the metrics and the panel majority.
