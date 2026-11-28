# OrgBench

This folder holds OrgBench, the org-scale benchmark for context engines ([ADR-075](../../../../.ai/memory/decisions/ADR-075-orgbench-org-scale-agent-benchmark.md)). Phase 1 ([CTX-1664](https://linear.app/ctxpipe/issue/CTX-1664)) runs Claude Code on answer-only tasks of the Zulip twin in three arms, records each run, and writes a report. [Harbor](https://github.com/harbor-framework/harbor) is the only runner (decision D1 of the plan). The phase 0 spike ([CTX-1660](https://linear.app/ctxpipe/issue/CTX-1660)) built the sidecars; phase 1 reuses them.

## The files

| File | What it is |
| --- | --- |
| `tasks/<twin>/<id>/` | One Harbor task for each question (see [The task format](#the-task-format)). |
| `arms.json` | The twins, the arms, the neutral preamble, the models with their list prices, the spend cap of each run and the server reserve of an arm. |
| `corpus.py` | Builds the B1+ corpus of a twin as plain files, also at a scale size. |
| `distractors.json` | The pinned distractor repositories of the scale sweep. |
| `run.py` | Runs each task × arm × model × trial as a Harbor job, stops before the spend cap, resumes from `runs.jsonl`, and reuses cached baseline runs. |
| `model-gateway.yaml` | The model gateway of each run: a Compose service that holds the model key and stops the run at its cap. |
| `mcp-proxy.yaml` | The MCP proxy of the CTX arm: a Compose service that holds the bench key and forwards only `/mcp`. |
| `record.py` | The recorder: one record for each run, with the MCP server spans from HyperDX and the D5 proof. |
| `analyze.py` | The analyzer: `runs.jsonl` to `report.json` and `report.md`. |
| `mint-key.ts` | Makes an org API key on a local stack (a candidate run, plan §5.4). |
| `requirements.in`, `requirements.txt` | The pinned Harbor release, and its lock with hashes (`uv pip compile --generate-hashes requirements.in`). |

## The task format

A task is a Harbor task folder: `instruction.md` (the question), `environment/Dockerfile` (the agent workspace), `tests/` (the verifier, which writes `/logs/verifier/reward.txt`, a score from 0 to 1). The agent writes its answer to `/app/answer.md`. The runner and the analyzer read these keys of `[metadata]` in `task.toml`:

| Key | Use |
| --- | --- |
| `family` | The task family (`T1`, `T3`, `T4`, `T8a`, `T10a`, `T11`, `T12`): a stratum of the report. |
| `lexical_hook` | `true` or `false`: a stratum of the report (ADR-075 decision 4). |
| `repos` | The repositories of the gold evidence, as `owner/name`. Their count is a stratum (1, 2, 3+). |
| `gold_context` | The gold files, as paths in the B1+ corpus (`repos/<name>/<path>`, `github/issues/…`, `github/pulls/…`, `chat/…`), each with an optional line range (`#L10-80`, or one line `#L42`). The ORACLE arm gets these files in its prompt. `run.py` refuses a path that is not in the corpus, also through a link. The recorder also uses them for the failure class: a run "saw" a gold file when a tool call named it or returned it. |

`task.toml` must set `[agent] network_mode = "allowlist"`, `allowed_hosts = []` and `[verifier] network_mode = "no-network"`; `run.py` refuses another task. The task folder holds no other file of the run. Harbor gives the agent only the instruction and the environment, and gives `tests/` only to the verifier.

## The arms

Each arm gets the same preamble (`arms.json`), with one sentence that tells where the sources are. Each arm disallows the web tools (`WebSearch`, `WebFetch`). The agent phase has no egress (`network_mode = "allowlist"` in `task.toml`) except to the hosts that `run.py` adds: the model gateway, and the MCP proxy in the CTX arm. The install of Claude Code runs before the agent phase, with network. The verifier has no network.

| Arm | Workspace | MCP |
| --- | --- | --- |
| `b1plus` | The B1+ corpus, mounted read-only at `/app/org`: `repos/<name>` (each repository at its pinned SHA, with no git history), `github/issues/` and `github/pulls/` (the Markdown of the frozen context repo), and `chat/` (the chat threads as Markdown). | None. |
| `ctx` | Empty. | The ctxpipe MCP of production (decision D4) at `http://ctxpipe-mcp-proxy/mcp`. The bench Workspace serves the context repo after the ctxpipe ingest, so its SHA is not the SHA of the B1+ corpus. Each CTX record names the SHA that it read (`served`), and the report shows it for each run. |
| `oracle` | Empty. The `gold_context` files of the task follow the preamble. One trial. | None. |

`corpus.py` builds the B1+ corpus from the plan of the twin (`../knowledge/fixtures/orgbench-zulip-v1.plan.json`) and the frozen context repo (`ctxpipe-ai/orgbench-zulip-context` at the SHA in `arms.json`). It reads the context repo through the `gh` login. It fetches each tree one time into `~/.cache/ctxpipe-bench/corpus/trees/`, and builds each corpus size as a view of hard links in `~/.cache/ctxpipe-bench/corpus/views/`. The name of a view holds a hash of its snapshot (each repository as `source@sha`, and the context repo), so a changed pin builds a new view. `run.py` builds the corpus only for a B1+ or ORACLE run that is not in the cache.

### The scale sweep

`run.py --repos N` (and `corpus.py --repos N`) mounts N repositories in the B1+ arm (plan §4.2). A size above the count of the plan adds the first distractor repositories of `distractors.json`: 192 public repositories of 18 other orgs (chat, video call and collaboration software, so that they are near the Zulip text), each at the last commit of its default branch before T. A size below the count of the plan keeps the first repositories of the plan (for 5: `zulip`, `zulip-flutter`, `zulip-mobile`, `zulip-desktop`, `zulip-terminal`). Thus pick the sweep tasks from the tasks whose repositories are in the first five. Each repository has the folder `repos/<name>`, with no owner, so that the path does not show which repositories are distractors. The sweep changes only the B1+ arm, so `run.py` refuses `--repos` with another arm: the CTX arm at 50 or 200 repositories needs a bench Workspace that indexes the distractors.

## The CTX arm

### The bench key stays in the MCP proxy

`ctxpipe-mcp-proxy` is a small Python proxy in a pinned image, in the Compose project of the trial (`mcp-proxy.yaml`). Each trial has its own proxy, so its limits apply to one run. It has these properties:

- `run.py` gives the bench key (`CTXPIPE_API_KEY`, a read-scope key of the bench org, ADR-075 decision 14) only to the Compose project of the trial. The proxy adds it as `x-api-key`. Claude Code gets the URL of the proxy and no header. It removes each credential and cookie that the client sends, and each `set-cookie` of the server. Thus the agent container has no key, and a transcript cannot show it.
- It adds the conversation id of the run (`x-ctxpipe-conversation-id`). The recorder joins the server spans by that id.
- It forwards only the path `/mcp` (exactly) to `--mcp-url` (default `https://app.ctxpipe.ai/mcp`). Each other path, also an encoded path such as `/api/x%2F..%2F..%2Fmcp`, gets 404.
- Only the tools of `mcpTools` in `arms.json`: `list_workspaces`, `search_knowledge`, `search_code`, `find_symbol`, `read_file`, `list_files`. Production has codesearch, so `search_code` and `find_symbol` are allowed. Claude Code also disallows `get_related`, but the agent can send a request with Bash, so the proxy refuses each other tool (403).
- At most `maxToolCalls` (120) tool calls in a run. The next tool call gets 429 from the proxy.
- One JSON-RPC message in each request: a batch gets 400. The body is at most 64 KiB.
- It removes the tracing headers of the client (`traceparent`, `tracestate`, `baggage`), so that a client cannot stop the sampling of the server spans.
- It writes `mcp/<run>/calls.json`: the forwarded tool calls, the tool calls that the server answered with 2xx, the HTTP status of each response of the server, the timeouts (300 s) and the connection errors, and the refused calls.

### The CTX arm reads only the knowledge plane (decision D5)

Decision D5 allows only the knowledge plane (ClickHouse and Jev) in the CTX arm. A run that touches FalkorDB is not valid. Only `get_related` can reach FalkorDB: when a Workspace is not ready on the plane, its fallback calls `expandWorkspaceGraph`. `search_code` and `find_symbol` read codesearch (Zoekt and SCIP). The fallback of each other tool reads Postgres or Git. Each fallback writes the log `knowledge_plane.fallback`.

The recorder reads the server spans of each CTX run from HyperDX (`DeploymentEnvironment` of `--telemetry-env`, default `production`): the traces whose `mcp.tool` span has the conversation id of the run. A CTX run is valid only when all of these are true:

- the traces of the run have no span with `db.system.name = falkordb` (or "falkor" in the span name);
- HyperDX has no `knowledge_plane.fallback` log of the bench org (`ctxpipe.org.slug`) or of the traces of the run, during the run;
- the traces have one `mcp.tool` span for each tool call that the server answered with 2xx, less the calls that the MCP SDK refused for bad arguments (those calls have no span). A call that failed with a 5xx, a 429 or a timeout is an own-service error, not a missing span.

The analyzer leaves out an invalid run, and lists it with its reasons. The record also holds `clickhouseSpans` and `jevCalls`, which show that the plane answered. The recorder waits up to five minutes for the spans of the run, because the backend exports spans in batches. The bench org is shared production, so the fallback check also counts a fallback of the bench org that does not come from the run.

## The model key stays in the model gateway

The agent can run Bash, and text in the corpus can tell it to send model requests. Thus the agent container never gets the model key, and it cannot reach the model host. `ctxpipe-model-gateway` is a small Python proxy in a pinned image, in the Compose project of the trial (`model-gateway.yaml`), in each arm. It has these properties:

- `run.py` gives the model key only to the Compose project of the trial (`MODEL_GATEWAY_KEY`). Claude Code gets `ANTHROPIC_BASE_URL=http://ctxpipe-model-gateway` and a dummy token. The egress allowlist holds the gateway, never the model host.
- It forwards only `POST /v1/messages` (the exact target, also with `?beta=true`), and only for the model of the run. It adds the key. Each other path gets 404, and another model gets 403.
- It allows only tokens: only the body fields and the beta features that the pinned Claude Code sends, and no server tool (web search, code execution), document block (PDF), image from a URL, one-hour cache write or compaction edit (403). It removes each other `anthropic-beta` value. Thus the model host cannot fetch a URL for the agent, and each cost of a request is a cost of its tokens.
- Before it forwards a request, it reserves the worst cost of the request: each byte of the body as one input token (a token is at least one byte) at the highest input price (a cache write), 5,000 tokens for each image, and `max_tokens` at the output price. It sets `max_tokens` to at most 16,000. When the spend of the run and the reserve are more than the cap of the run (`runCapUsd`), it refuses the request with 402. It sends one request at a time.
- After the response, it reads the `usage` of the response (also a streamed response), and charges it at the list price of the model (`pricesUsdPerMTok` in `arms.json`, with the long-context price of Haiku above 100,000 tokens). When the client goes before the end, it reads the response to the end. When a response of 200 has no full usage, it charges the reserve. An error response with no usage costs nothing. Thus the spend of a run can never go over its cap.
- It writes the spend of the run to `gateway/<run>/spend.json` in the run folder. The recorder uses that total as the agent spend, because it also counts a model request that did not come from Claude Code.

## The environment of Harbor

`run.py` does not give Harbor a copy of the host environment. It gives only `PATH`, `HOME`, `DOCKER_HOST`, the values of the two sidecars (`MODEL_GATEWAY_*`, and `MCP_PROXY_*` with the bench key in a CTX run), the dummy token of Claude Code, `HARBOR_TELEMETRY=0`, and `PYTHON_DOTENV_DISABLED=1`. The last one is necessary: litellm, a dependency of Harbor, loads the first `.env` file above the working folder when Harbor starts (in a worktree, that can be the `.env` of the main checkout).

## Set up

1. Install Harbor from `apps/backend`: `uv venv && uv pip install --require-hashes -r evals/bench/requirements.txt`.
2. Use a Docker that shares your home folder (Colima shares only the home folder): the run folder and the corpus are bind mounts.
3. Get the keys. The model key is the key of `factory eval`: `MODEL_PROVIDER_API_KEY`, or the login keychain item `factory-model-provider` (an OpenRouter key; `ANTHROPIC_BASE_URL=https://openrouter.ai/api`). The bench key is the read-scope key of the production bench org. The HyperDX values are the three variables of an agent host ([USING.md](../../../../ops/observability/USING.md#agent-hosts)). Put them in the environment of `run.py` from a file or the keychain, not on the command line.
4. Keep the run folders, the corpus and the cache in `~/.cache/ctxpipe-bench/`, not in `/tmp` (a restart clears it).

## Run

```sh
ANTHROPIC_BASE_URL=https://openrouter.ai/api ANTHROPIC_AUTH_TOKEN=… CTXPIPE_API_KEY=… HYPERDX_…=… \
  .venv/bin/python evals/bench/run.py --out ~/.cache/ctxpipe-bench/runs/RUN \
  [--tasks-dir evals/bench/tasks/zulip-v1] [--tasks a,b] [--arms b1plus,ctx,oracle] \
  [--models haiku] [--trials 2] [--repos 50] [--cap-usd 2]
.venv/bin/python evals/bench/analyze.py ~/.cache/ctxpipe-bench/runs/RUN [--pass-at 1.0]
```

- Each run is one Harbor job with the stock `claude-code` agent at a pinned Claude Code version, with `--max-turns` and `--max-budget-usd` (the cap of the run in `arms.json`). `run.py` writes the report at the end; `analyze.py` writes it again, for example with another pass threshold.
- Before each run, `run.py` adds the cap of the run and the server reserve of the arm to the spend so far. When the sum is more than `--cap-usd`, it stops with exit code 3. The server calls of a CTX run (a query embedding and about two Jev calls for each search) have no dollar cap of their own: the proxy limits their count, and the CTX reserve ($0.12) is an estimate. The recorded server spend (`gen_ai.usage.cost` of the spans of the run) counts in the spend.
- A run with an infrastructure error (a harness crash, no result event, no reward, or a model API error) runs again, at most three attempts. An error of the arm's own service (a 5xx, a 429 or a timeout of the MCP server, or a tool error `internal`, `too_many_requests`, `judge_unavailable` or `workspace_not_ready`) does not run again: the run fails with score 0 (ADR-075 decision 7). A run that stops at its turn, time or dollar limit (a result `error_max_*`, a request that the gateway refused, or the agent timeout of Harbor) does not run again and fails the task; with no reward, its score is 0.
- Before and after each CTX run, `run.py` reads the snapshot that the Workspace serves (`list_files` of the root, field `served`) into `snapshot` of the record. Thus a run with no tool result also names its snapshot.
- Before each run, `run.py` writes its reserve to `gateway/<run>/reserve.txt`. A run with no record (an invocation that stopped during the run) keeps that full reserve in the spend of the next invocation.
- **The cache.** A baseline arm (an arm with no MCP: `b1plus`, `oracle`) reuses a record from `~/.cache/ctxpipe-bench/cache/` when the key is the same: a hash of the task folder, the snapshot (the plan, the context repo SHA and the repository count), the harness (the Harbor and Claude Code versions, the turn limit), the model with its prices and cap, the arm config with its preamble, and the trial. A cached record has `cached: true`, and its cost does not count in the spend of the new invocation. The CTX arm never uses the cache, because production can change.
- **A candidate run (plan §5.4)** uses a local stack: `--mcp-url http://host.docker.internal:3660/mcp --telemetry-env local-<name>`, with a backend that exports its spans to the shared collector ([USING.md](../../../../ops/observability/USING.md#localhost-telemetry)) and an org key from `mint-key.ts`. The proxy reaches the host, and the agent still reaches only the proxy.
- With an OpenRouter key, `run.py` also reads the upstream spend of the key (`byok_usage`) before and after all its runs, and writes the change and the Claude Code total to `byok.jsonl`. The counter lags by up to a minute, so it checks the total, not each run.

## The record of a run

`runs.jsonl` holds one record for each run: the score (and `rawScore`, the score of the grader before an own-service error), the matched facts, the tokens (input, output, cache read, cache write), the Claude Code cost, the gateway total, the turns, the agent time and the wall time, the tool calls of the transcript, the MCP error results (`mcpErrors`: the tool error code, or `schema` for bad arguments that the MCP SDK refused), the argument errors, the own-service errors, the gold files that the run saw, the snapshot that a CTX run read (`served`: the `branch@sha` of each hit and file in the MCP results, for example `main@<sha>` for the Workspace and `<sha>@<sha>` for a pinned repository), the proxy counts, the server spans (calls and error codes for each tool, ClickHouse spans, Jev calls, model cost), the D5 proof (`valid`, `invalidReasons`), and the error class (`infra`, `own-service` or none). The trial folder of each run holds the full transcript (`agent/claude-code.txt`, `agent/trajectory.json`) and the verifier output.

## The report

`analyze.py` writes `report.json` and `report.md`. For each model and corpus size, it gives:

- for each arm: the mean continuous score, pass@1 (the first trial of each task), pass^k (each of the first k trials passes; k is the smallest count of trials of a task), $/task (the mean cost of one run), $/success, the mean tokens, the wall time and the turns;
- the paired delta of each arm against B1+: the mean over the tasks of the difference of the mean trial scores, with a 95% bootstrap interval over the tasks, and the strata by `family`, `lexical_hook` and repository count;
- the process of the CTX arm: the MCP calls and their share of the tool calls, the tasks with no MCP call, the argument errors and their rate, the runs with an own-service error, the server tools, the Jev calls, the D5 counts, and the served snapshots (two SHAs of the Workspace branch mean that the snapshot changed during the runs);
- the failure class of each failed run: own-service error, infra (an infrastructure error that did not run again), tool not used (a CTX run with no MCP call), reasoning with gold seen (the run saw a gold file, or the arm is ORACLE), bad args (an argument error and no gold file seen), or retrieval miss.
