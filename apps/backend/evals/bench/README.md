# OrgBench spike (CTX-1660)

This folder holds the phase 0 spike of OrgBench, the org-scale benchmark for context engines. The spike runs Claude Code on three answer-only tasks in two arms, and records the score, the tokens, the cost, the time and the MCP calls of each run. [Harbor](https://github.com/harbor-framework/harbor) is the only runner (decision D1 of the plan). The spike is thin on purpose: the full benchmark replaces most of it.

## The files

| File | What it is |
| --- | --- |
| `tasks/<id>/` | One Harbor task for each question: `instruction.md` (the question), `environment/Dockerfile` (the agent workspace), `tests/` (the verifier). Harbor copies only the task folder into the container, so each task has its own copy of `grade.py`. |
| `arms.json` | The arms, the neutral preamble, the models, the spend cap of each run and the reserve for the server calls of an arm. |
| `run.py` | Runs each task × arm × model one time as a Harbor job, stops before the spend cap, and resumes from `runs.jsonl`. |
| `mcp-proxy.yaml` | The MCP proxy of the CTX arm: a Compose service that Harbor adds to the job of a CTX run. |
| `record.py` | The recorder: one record for each run, and `report.md`. |
| `mint-key.ts` | Makes an org API key for the CTX arm. |
| `requirements.in`, `requirements.txt` | The pinned Harbor release, and its lock with hashes (`uv pip compile --generate-hashes requirements.in`). |

## The tasks

The three questions come from the dev split of `../knowledge/fixtures/backstage-v0.dataset.json`. Each question needs more than one source:

| Task | Category | Gold |
| --- | --- | --- |
| `backstage-multi-hop-27` | multi-hop | three linked issues |
| `backstage-cross-source-12` | cross-source | an issue and the knowledge document of the endpoint |
| `backstage-cross-source-13` | cross-source | an issue and the knowledge document of the API |

The agent writes its answer to `/app/answer.md`. The verifier (`tests/grade.py`) scores the answer against the key facts of the dataset. Each key fact has groups of regular expressions in `tests/gold.json`, and the fact matches when each group has a match. The reward is the fraction of the facts that match. When the agent wrote no `/app/answer.md`, the verifier scores the final text of the run, and `facts.json` says so (`answer_source`). Each `gold.json` gives 1.0 for the text of its own key facts, and 0 for an empty answer and for the question text. This check is crude on purpose. The claims rubric and the judge panel of the plan replace it.

## The arms

Both arms get the same preamble (`arms.json`), with one sentence that tells where the sources are. Both arms disallow the web tools (`WebSearch`, `WebFetch` in `disallowedTools`). The agent phase has no egress (`network_mode = "allowlist"` in `task.toml`) except to the hosts that `run.py` adds: the model endpoint, and the MCP proxy in the CTX arm. The install of Claude Code runs before the agent phase, with network. The verifier has no network.

| Arm | Workspace | MCP |
| --- | --- | --- |
| `b1plus` | The corpus as plain files, mounted read-only at `/app/org`: `repos/backstage` (the source at the frozen SHA) and `issues/` (the issue mirror of the frozen context repo, one Markdown file for each issue). | None. |
| `ctx` | Empty. | The ctxpipe MCP over HTTP at `http://ctxpipe-mcp-proxy/mcp`, with the headers `x-api-key` and `x-ctxpipe-conversation-id`. |

### The CTX arm reaches only the MCP

On Colima and Docker Desktop, a container can connect to each port of the host through `host.docker.internal`. This includes the stores of the bench (FalkorDB, ClickHouse, Postgres). Harbor allows hosts, not ports. Thus the allowlist of the CTX arm never holds `host.docker.internal`. It holds only the model host and `ctxpipe-mcp-proxy`.

`ctxpipe-mcp-proxy` is a pinned nginx in the Compose project of the trial (`mcp-proxy.yaml`). It forwards only the path `/mcp` to the backend at `host.docker.internal:3660`, with the headers of the request. It sends the path `/mcp` itself, not the path of the request, so an encoded path such as `/api/x%2F..%2F..%2Fmcp` also gets to `/mcp` only. Each other path gets 404, and the proxy listens on no other port. The proxy sends the Host header `host.docker.internal:3660`, the host of `AUTH_BASE_URL`, so the DNS rebinding check of the backend accepts the request. The egress sidecar of Harbor sniffs the HTTP Host and the TLS SNI, and it connects to that host, not to the address of the packet. Thus a request to the address of the host with the Host header `ctxpipe-mcp-proxy` goes to the proxy, not to the host.

A probe in a task container of the CTX arm (the `oracle` agent, with the same network setup) got these results: `POST /mcp` through the proxy gave 200 with the org key and 401 with no key, other paths gave 404, the encoded path above got to `/mcp` (401 with no key), and FalkorDB (16379), ClickHouse (18123), Postgres (5433) and the backend (3660) on `host.docker.internal` sent no data, also with a false Host header. From a container with no egress control, the same probe got `+PONG`, `200 OK` and an answer from Postgres.

### The CTX arm reads only the knowledge plane (decision D5)

Decision D5 of the plan allows only the knowledge plane (ClickHouse and Jev, the org flag `knowledge_plane` at `on`) in the CTX arm. A run that touches FalkorDB is not valid. The code gives this result for the seven MCP tools when the flag is `on`:

| Tool | Can it reach FalkorDB? | The path |
| --- | --- | --- |
| `list_workspaces` | No | Postgres and Git only. Its `readiness.graph` field is a Postgres column of the published revision, not a FalkorDB query. |
| `search_knowledge` | No | The plane (`planeKnowledgeReader`). When a Workspace in scope is not ready on the plane, `selectKnowledgeReader` falls back to the old stack, which is the Postgres search (`searchKnowledge`), not FalkorDB. |
| `search_code` | No | codesearch (Zoekt). |
| `find_symbol` | No | codesearch (Zoekt and SCIP). |
| `read_file` | No | The plane file (Git at the plane SHA). The fallback reads the Postgres units or the Git checkout. |
| `list_files` | No | The plane view. The fallback reads the Postgres units. |
| `get_related` | **Yes** | The plane walk. When a Workspace is not ready on the plane, the fallback is `legacyKnowledgeReader.related`, which calls `expandWorkspaceGraph`, a FalkorDB query. |

Thus the CTX arm disallows `mcp__ctxpipe__get_related` (Claude Code `--disallowedTools`). Each fallback writes the log `knowledge_plane.fallback`, so the recorder also counts these logs. The spike also disallows `search_code` and `find_symbol`, because the local stack has no codesearch index of the corpus repositories. Each run proves D5 three ways:

- `falkorGraphCommands`: the change of the `GRAPH.*` command count of the FalkorDB of the backend (`INFO commandstats`) during the run. The bench backend has a FalkorDB of its own, so no other process adds to the count.
- `server.falkorSpans`: the `falkordb` spans in the traces of the MCP calls of the run.
- `server.planeFallbackLogs`: the `knowledge_plane.fallback` logs during the run. `server.jevCalls` shows that the plane answered.

## Set up the local stack

The CTX arm needs a backend with the frozen corpus on the plane. Do these steps one time. All the paths that Docker mounts (the run folder, the corpus, the collector output) must be in a folder that the Docker VM shares. Colima shares only your home folder.

1. Get the stores of the corpus. `../knowledge` `hydrate` writes the frozen context repo into Postgres, FalkorDB and ClickHouse (see `../knowledge/README.md`). The context repo is private, so a hydrate serves it from a local Git server. To reuse an earlier hydrate, copy its Postgres database (`CREATE DATABASE … TEMPLATE …`), migrate the copy, and copy the plane rows of the Workspace into a ClickHouse of your own (`SELECT … FORMAT Native` into `INSERT … FORMAT Native`, with the setting `SQL_ctxpipe_org_id`).
2. In the copy, keep only the Workspace of the corpus, and set the flag `knowledge_plane` of the org to `on`. Serve the context repo with `src/test/git-http-server.ts`, and point the remote URL of the Workspace revision at it.
3. Start an empty FalkorDB for the backend (`GRAPH_DB_URI`), and an OpenTelemetry collector that writes OTLP JSON lines to a file (the `file` exporter). Set `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` and `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` of the backend to it.
4. Start the backend on port 3660 (`mcp-proxy.yaml` forwards to that port), and set `AUTH_BASE_URL` of the backend to `http://host.docker.internal:3660`. With a loopback base URL, `/mcp` refuses each request from the proxy (the DNS rebinding check of `rejectInvalidMcpOrigin`).
5. Start the backend alone, with no worker: `bun --env-file=BENCH.env src/server.ts` from `apps/backend`. Do not use `pnpm dev`.
6. Make the org key: `bun --env-file=BENCH.env evals/bench/mint-key.ts --org ORG_ID --out KEY_FILE`.
7. Make the B1+ corpus: `repos/backstage` (a `git fetch --depth 1` of the frozen SHA, with no `.git`) and `issues/` (`git archive` of `github/issues` of the frozen context repo).
8. Install Harbor from `apps/backend`: `uv venv && uv pip install --require-hashes -r evals/bench/requirements.txt`.

## Run

```sh
DOCKER_HOST=… ANTHROPIC_BASE_URL=https://openrouter.ai/api ANTHROPIC_AUTH_TOKEN=… CTXPIPE_API_KEY=… \
  .venv/bin/python evals/bench/run.py --out ~/RUN --corpus ~/CORPUS --otlp ~/OTEL/otlp.jsonl \
  --falkor-container FALKOR [--models haiku,sonnet] [--arms b1plus,ctx] [--tasks …] [--cap-usd 2]
python evals/bench/record.py ~/RUN   # writes report.md again from runs.jsonl
```

- Use the model keys of `factory eval`: the factory gets the model key from `MODEL_PROVIDER_API_KEY` or the login keychain (`factory-model-provider`). Give the backend (`MODEL_PROVIDER_API_KEY`) the same key. The limit of that key does not count the Claude calls (provider-key, BYOK, usage), so the spend cap is `--cap-usd` of `run.py` and the `--max-budget-usd` of each run. `run.py` also stops a run when its server calls use half of the server reserve of the arm.
- The CTX arm reaches the backend only through the MCP proxy (see [The CTX arm reaches only the MCP](#the-ctx-arm-reaches-only-the-mcp)).
- Each run is one Harbor job with the stock `claude-code` agent at a pinned Claude Code version, with `--max-turns` and `--max-budget-usd` (the cap of the run in `arms.json`).
- Before each run, `run.py` adds the cap of the run and the server reserve of the arm to the spend so far. When this sum is more than `--cap-usd`, it stops with exit code 3. The order is model, then task, then arm, so a stop leaves whole pairs of arms.
- The backend has no spend limit for its model calls (one query embedding and about two Jev calls for each search, at most $0.001 measured). Thus `run.py` limits them. During a run, it reads the server cost from the spans every 5 s: the cost of each span of the bench backend since the start of the run, also of a call with no conversation id or the id of another run. It stops the Harbor job when the cost gets to half of the server reserve of the arm. The spans come up to about 15 s late. The MCP proxy forwards at most one request each second, so in those 15 s at most about 15 calls (about $0.015) go to the backend. This is less than the other half of the CTX reserve ($0.06 of $0.12), so the server calls of a run stay in the reserve.
- A run with no result event or no reward is a failed run: it keeps its spend, `run.py` exits with 1, and the next invocation runs it again.
- The spend of a run is the Claude Code `total_cost_usd` (the full cap of the run when the run has no result event), plus the cost of the model calls of the bench backend after the start of the run (`gen_ai.usage.cost` on its spans: the query embeddings and Jev; `server.backendCostUsd`). `server.modelCostUsd` is the part of the MCP calls of the run.
- With an OpenRouter key, `run.py` also reads the upstream spend of the key (`byok_usage`) before and after all its runs, and writes the change and the Claude Code total to `gateway.jsonl`. The counter lags by up to a minute, so it checks the total, not each run.

## The record of a run

`runs.jsonl` holds one record for each run: the reward and the matched facts, the tokens (input, output, cache read, cache write), the Claude Code cost, the turns, the agent time and the wall time, the tool calls of the transcript and the MCP calls that gave an error result (`mcpFailedCalls`: bad arguments that the MCP SDK refused, which have no span, and the errors of the tools), the MCP server spans of the run (joined by `ctxpipe.mcp.conversation.id`: the calls and the error codes for each tool, the Jev calls, the model cost of the server) and the D5 proof. The trial folder of each run holds the full transcript (`agent/claude-code.txt`, `agent/trajectory.json`) and the verifier output.
