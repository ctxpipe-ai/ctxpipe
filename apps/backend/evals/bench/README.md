# OrgBench spike (CTX-1660)

This folder holds the phase 0 spike of OrgBench, the org-scale benchmark for context engines. The spike runs Claude Code on three answer-only tasks in two arms, and records the score, the tokens, the cost, the time and the MCP calls of each run. [Harbor](https://github.com/harbor-framework/harbor) is the only runner (decision D1 of the plan). The spike is thin on purpose: the full benchmark replaces most of it.

## The files

| File | What it is |
| --- | --- |
| `tasks/<id>/` | One Harbor task for each question: `instruction.md` (the question), `environment/Dockerfile` (the agent workspace), `tests/` (the verifier). Harbor copies only the task folder into the container, so each task has its own copy of `grade.py`. |
| `arms.json` | The arms, the neutral preamble, the models with their list prices, the spend cap of each run and the reserve for the server calls of an arm. |
| `run.py` | Runs each task × arm × model one time as a Harbor job, stops before the spend cap, and resumes from `runs.jsonl`. |
| `model-gateway.yaml` | The model gateway of each run: a Compose service that holds the model key and stops the run at its cap. |
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

Both arms get the same preamble (`arms.json`), with one sentence that tells where the sources are. Both arms disallow the web tools (`WebSearch`, `WebFetch` in `disallowedTools`). The agent phase has no egress (`network_mode = "allowlist"` in `task.toml`) except to the hosts that `run.py` adds: the model gateway, and the MCP proxy in the CTX arm. The install of Claude Code runs before the agent phase, with network. The verifier has no network.

| Arm | Workspace | MCP |
| --- | --- | --- |
| `b1plus` | The corpus as plain files, mounted read-only at `/app/org`: `repos/backstage` (the source at the frozen SHA) and `issues/` (the issue mirror of the frozen context repo, one Markdown file for each issue). | None. |
| `ctx` | Empty. | The ctxpipe MCP over HTTP at `http://ctxpipe-mcp-proxy/mcp`, with the headers `x-api-key` and `x-ctxpipe-conversation-id`. |

### The CTX arm reaches only the MCP

On Colima and Docker Desktop, a container can connect to each port of the host through `host.docker.internal`. This includes the stores of the bench (FalkorDB, ClickHouse, Postgres). Harbor allows hosts, not ports. Thus the allowlist of the CTX arm never holds `host.docker.internal`. It holds only `ctxpipe-model-gateway` and `ctxpipe-mcp-proxy`.

`ctxpipe-mcp-proxy` is a small Python proxy in a pinned image, in the Compose project of the trial (`mcp-proxy.yaml`). Each trial has its own proxy, so its limits apply to one run. It forwards only the path `/mcp` (exactly) to the backend at `host.docker.internal:3660`, with the headers of the request (`x-api-key`, `x-ctxpipe-conversation-id`). Each other path, also an encoded path such as `/api/x%2F..%2F..%2Fmcp`, gets 404, and the proxy listens on no other port. It also has these limits. They limit the count of the tool calls of a run, not their cost:

- Only the tools that the CTX arm allows (`list_workspaces`, `search_knowledge`, `read_file`, `list_files`). Claude Code disallows the other tools, but the agent can send a request with Bash, so the proxy also refuses them (403). Thus the agent cannot call `get_related`, which can reach FalkorDB (D5).
- At most 120 tool calls in a run (`MAX_TOOL_CALLS`, three searches in each of the 40 turns of the reserve). The next tool call gets 429.
- One JSON-RPC message in each request: a batch gets 400. The body is at most 64 KiB.
- It removes the tracing headers of the client (`traceparent`, `tracestate`, `baggage`). Thus a client cannot stop the sampling of the model calls of the backend, and the recorder counts each of them.

The proxy sends the Host header `host.docker.internal:3660`, the host of `AUTH_BASE_URL`, so the DNS rebinding check of the backend accepts the request. The egress sidecar of Harbor sniffs the HTTP Host and the TLS SNI, and it connects to that host, not to the address of the packet. Thus a request to the address of the host with the Host header `ctxpipe-mcp-proxy` goes to the proxy, not to the host.

A probe in a task container of the CTX arm (the `oracle` agent, with the same network setup) got these results: `POST /mcp` through the proxy gave 200 with the org key and 401 with no key, other paths and the encoded path above gave 404, a batch gave 400, `get_related` gave 403, tool calls 1 to 120 gave 200 and call 121 gave 429, the backend sampled all 120 calls although each sent an unsampled `traceparent`, and FalkorDB (16379), ClickHouse (18123), Postgres (5433) and the backend (3660) on `host.docker.internal` sent no data, also with a false Host header. From a container with no egress control, the same probe got `+PONG`, `200 OK` and an answer from Postgres.

### The model key stays in the model gateway

The agent can run Bash, and text in the corpus can tell it to send model requests. Thus the agent container never gets the model key, and it cannot reach the model host. `ctxpipe-model-gateway` is a small Python proxy in a pinned image, in the Compose project of the trial (`model-gateway.yaml`), in both arms. It has these properties:

- `run.py` gives the model key only to the Compose project of the trial (`MODEL_GATEWAY_KEY`). Claude Code gets `ANTHROPIC_BASE_URL=http://ctxpipe-model-gateway` and a dummy token. The egress allowlist holds the gateway, never the model host.
- It forwards only `POST /v1/messages` (the exact target, also with `?beta=true`), and only for the model of the run. It adds the key. Each other path gets 404, and another model gets 403.
- It allows only tokens: only the body fields and the beta features that the pinned Claude Code sends, and no server tool (web search, code execution), document block (PDF), image from a URL, one-hour cache write or compaction edit (403). It removes each other `anthropic-beta` value. Thus the model host cannot fetch a URL for the agent, and each cost of a request is a cost of its tokens.
- Before it forwards a request, it reserves the worst cost of the request: each byte of the body as one input token (a token is at least one byte) at the highest input price (a cache write), 5,000 tokens for each image, and `max_tokens` at the output price. It sets `max_tokens` to at most 16,000. When the spend of the run and the reserve are more than the cap of the run (`runCapUsd`), it refuses the request with 402. It sends one request at a time.
- After the response, it reads the `usage` of the response (also a streamed response), and charges it at the list price of the model (`pricesUsdPerMTok` in `arms.json`, with the long-context price of Haiku above 100,000 tokens). When the client goes before the end, it reads the response to the end. When a response of 200 has no full usage, it charges the reserve. An error response with no usage costs nothing. Thus the spend of a run can never go over its cap. The reserve of a big request is large (about $0.41 for a Sonnet request of 100 KB), so the caps of a run (`runCapUsd`: Haiku $0.3, Sonnet $1) are higher than the measured cost of a run. The gateway refuses a request when its reserve is more than the rest of the cap: for example, a Sonnet request above about 270 KB (about 65,000 tokens of context) after $0.15 of spend, and a Haiku request above about 400 KB after $0.01 of spend.
- It writes the spend of the run to `gateway/<run>/spend.json` in the run folder. The recorder uses that total as the agent spend, because it also counts a model request that did not come from Claude Code.

A probe in a task container (the `oracle` agent, with the network setup of a CTX run) got these results: no environment variable, process environment or file had the model key, and `openrouter.ai` and `api.anthropic.com` sent no answer. The gateway gave 200 with the dummy token (with and without a stream), 403 for another model, a server tool, a document block, an image from a URL, a one-hour cache write, the `speed` field and a compaction edit, and 404 for another path. It closed the connection of a 5 MB body. It charged a request whose client went before the headers. With a budget of $0.003, it refused the third long request with 402, and its total was $0.00218. Two runs through the gateway on `backstage-cross-source-13` (Haiku CTX, reward 1.0, and Sonnet B1+, reward 0.67) had gateway totals of $0.007032 (5 requests) and $0.130086 (10 requests). Each total is equal to the Claude Code `total_cost_usd` and to the change of the upstream spend of the key (`byok_usage`). The run folders had no copy of the model key.

### The CTX arm reads only the knowledge plane (decision D5)

Decision D5 of the plan allows only the knowledge plane (ClickHouse and Jev) in the CTX arm. A run that touches FalkorDB is not valid. The code gives this result for the seven MCP tools:

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
2. In the copy, keep only the Workspace of the corpus. Serve the context repo with `src/test/git-http-server.ts`, and point the remote URL of the Workspace revision at it.
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

- Use the model keys of `factory eval`: the factory gets the model key from `MODEL_PROVIDER_API_KEY` or the login keychain (`factory-model-provider`). Give the backend (`MODEL_PROVIDER_API_KEY`) the same key. The limit of that key does not count the Claude calls (provider-key, BYOK, usage), so the spend cap is `--cap-usd` of `run.py`, which the model gateway enforces for each run (see [The model key stays in the model gateway](#the-model-key-stays-in-the-model-gateway)).
- Each run is one Harbor job with the stock `claude-code` agent at a pinned Claude Code version, with `--max-turns` and `--max-budget-usd` (the cap of the run in `arms.json`).
- Before each run, `run.py` adds the cap of the run and the server reserve of the arm to the spend so far. When the sum is more than `--cap-usd`, it stops with exit code 3. The model gateway enforces the cap of the run, in dollars. The server calls have no dollar limit for each run: the backend calls the model host from the host, with its own key. Thus the CTX reserve ($0.12) is an estimate: each search makes one query embedding and about two Jev calls (at most $0.001 measured), and it assumes at most three searches in each of the `maxTurns` (40) turns. The MCP proxy enforces that count: at most 120 tool calls in a run. The recorded server spend of each run counts, so `run.py` stops before a run when the recorded spend and the reserve of the next run are more than the cap.
- A run with no result event or no reward is a failed run: it keeps its spend, `run.py` exits with 1, and the next invocation runs it again. Before each run, `run.py` writes its reserve to `gateway/<run>/reserve.txt`. A run with no record (an invocation that stopped during the run) keeps that full reserve in the spend of the next invocation.
- The spend of a run is the total of the model gateway (the Claude Code `total_cost_usd` when there is no gateway total, and the full cap of the run when the run has neither), plus the cost of the model calls of the bench backend after the start of the run (`gen_ai.usage.cost` on its spans: the query embeddings and Jev; `server.backendCostUsd`). This also counts a call with no conversation id or the id of another run. `server.modelCostUsd` is the part of the MCP calls of the run.
- With an OpenRouter key, `run.py` also reads the upstream spend of the key (`byok_usage`) before and after all its runs, and writes the change and the Claude Code total to `byok.jsonl`. The counter lags by up to a minute, so it checks the total, not each run.

## The record of a run

`runs.jsonl` holds one record for each run: the reward and the matched facts, the tokens (input, output, cache read, cache write), the Claude Code cost, the total of the model gateway (`gatewayCostUsd`, with its requests and its refused requests), the turns, the agent time and the wall time, the tool calls of the transcript and the MCP calls that gave an error result (`mcpFailedCalls`: bad arguments that the MCP SDK refused, which have no span, and the errors of the tools), the MCP server spans of the run (joined by `ctxpipe.mcp.conversation.id`: the calls and the error codes for each tool, the Jev calls, the model cost of the server) and the D5 proof. The trial folder of each run holds the full transcript (`agent/claude-code.txt`, `agent/trajectory.json`) and the verifier output.
