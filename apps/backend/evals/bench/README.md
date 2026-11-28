# OrgBench

This folder holds OrgBench, the org-scale benchmark for context engines ([ADR-075](../../../../.ai/memory/decisions/ADR-075-orgbench-org-scale-agent-benchmark.md)). Phase 1 ([CTX-1664](https://linear.app/ctxpipe/issue/CTX-1664)) runs Claude Code on answer-only tasks of the Zulip twin in three arms, records each run, and writes a report. [Harbor](https://github.com/harbor-framework/harbor) is the only runner (decision D1 of the plan). The phase 0 spike ([CTX-1660](https://linear.app/ctxpipe/issue/CTX-1660)) built the sidecars; phase 1 reuses them. Phase 2 ([CTX-1665](https://linear.app/ctxpipe/issue/CTX-1665)) adds the machinery of a climb: the tiers, a candidate CTX against the kept CTX in one batch, the B1+ sentinel, the keep rule, and the smoke check.

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
| `analyze.py` | The analyzer: `runs.jsonl` to `report.json` and `report.md`, with the keep rule for a candidate. |
| `tiers.json` | The tiers (their splits, arms, models, trials and caps), the B1+ sentinel and the margins of the keep rule. |
| `tiers.py` | The tasks of a tier, the verdict of the smoke tier, and `pick-smoke` (the smoke list from a baseline). |
| `mint-key.ts` | Makes an org API key on a local stack (a candidate run, plan §5.4). |
| `requirements.in`, `requirements.txt` | The pinned Harbor release, and its lock with hashes (`uv pip compile --generate-hashes requirements.in`). |

## The task format

A task is a Harbor task folder: `instruction.md` (the question), `environment/Dockerfile` (the agent workspace), `tests/` (the verifier, which writes `/logs/verifier/reward.txt`, a score from 0 to 1). The agent writes its answer to `/app/answer.md`. The runner and the analyzer read these keys of `[metadata]` in `task.toml`:

| Key | Use |
| --- | --- |
| `split` | `dev`, `holdout` or `sealed`. Each task must have it. A run with no tier takes only dev tasks; a holdout task runs only with `--tier holdout` or `release`, and a sealed task only with `--tier release`. |
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
- Only the tools of `mcpTools` in `arms.json`: `list_workspaces`, `search_knowledge`, `search_code`, `find_symbol`, `get_related`, `read_file`, `list_files`. Production has codesearch, so `search_code` and `find_symbol` are allowed. The agent can send a request with Bash, so the proxy refuses each other tool (403).
- At most `maxToolCalls` (120) tool calls in a run. The next tool call gets 429 from the proxy.
- One JSON-RPC message in each request: a batch gets 400. The body is at most 64 KiB.
- It removes the tracing headers of the client (`traceparent`, `tracestate`, `baggage`), so that a client cannot stop the sampling of the server spans.
- It writes `mcp/<run>/calls.json`: the forwarded tool calls, the tool calls that the server answered with 2xx, the HTTP status of each response of the server, the timeouts (300 s) and the connection errors, and the refused calls.

### The CTX arm reads only the knowledge plane (decision D5)

Decision D5 allows only the knowledge plane (ClickHouse and Jev, the org flag `knowledge_plane` at `on`) in the CTX arm. The bench Workspace is ready on the plane, so `get_related` reads the plane graph (ClickHouse and Jev). The CTX arm allows each of the seven tools: the checks of `record.py` enforce D5, not the removal of a tool. `search_code` and `find_symbol` read codesearch (Zoekt and SCIP). When a Workspace is not ready on the plane, the fallback of each tool reads Postgres or Git. Each fallback writes the log `knowledge_plane.fallback`. A run with a fallback did not use the plane.

The recorder reads the server spans of each CTX run from HyperDX (`DeploymentEnvironment` of `--telemetry-env`, default `production`): the traces whose `mcp.tool` span has the conversation id of the run. A CTX run is valid only when all of these are true:

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
  [--tier smoke|dev|holdout|release] [--tasks-dir evals/bench/tasks/zulip-v1] [--tasks a,b] \
  [--arms b1plus,ctx,oracle] [--models haiku] [--trials 2] [--repos 50] [--cap-usd 2]
.venv/bin/python evals/bench/analyze.py ~/.cache/ctxpipe-bench/runs/RUN [--pass-at 1.0] [--l0-win]
```

- Each run is one Harbor job with the stock `claude-code` agent at a pinned Claude Code version, with `--max-turns` and `--max-budget-usd` (the cap of the run in `arms.json`). `run.py` writes the report at the end; `analyze.py` writes it again, for example with another pass threshold.
- Before each run, `run.py` adds the cap of the run and the server reserve of the arm to the spend so far. When the sum is more than `--cap-usd`, it stops with exit code 3. The server calls of a CTX run (a query embedding and about two Jev calls for each search) have no dollar cap of their own: the proxy limits their count, and the CTX reserve ($0.12) is an estimate. The recorded server spend (`gen_ai.usage.cost` of the spans of the run) counts in the spend.
- A run with an infrastructure error (a harness crash, no result event, no reward, or a model API error) runs again, at most three attempts. An error of the arm's own service (a 5xx, a 429 or a timeout of the MCP server, or a tool error `internal`, `too_many_requests`, `judge_unavailable` or `workspace_not_ready`) does not run again: the run fails with score 0 (ADR-075 decision 7). A run that stops at its turn, time or dollar limit (a result `error_max_*`, a request that the gateway refused, or the agent timeout of Harbor) does not run again and fails the task; with no reward, its score is 0.
- Before and after each CTX run, `run.py` reads the snapshot that the Workspace serves (`list_files` of the root, field `served`) into `snapshot` of the record. Thus a run with no tool result also names its snapshot.
- Before each run, `run.py` writes its reserve to `gateway/<run>/reserve.txt`. A run with no record (an invocation that stopped during the run) keeps that full reserve in the spend of the next invocation.
- **The cache.** A baseline arm (an arm with no MCP: `b1plus`, `oracle`) reuses a record from `~/.cache/ctxpipe-bench/cache/` when the key is the same: a hash of the task folder, the snapshot (the plan, the context repo SHA and the repository count), the harness (the Harbor and Claude Code versions, the turn limit), the model with its prices and cap, the arm config with its preamble, and the trial. A cached record has `cached: true`, and its cost does not count in the spend of the new invocation. The CTX arm never uses the cache, because production can change.
- **A candidate** runs against a local stack (see [Candidate and kept](#candidate-and-kept)).
- With an OpenRouter key, `run.py` also reads the upstream spend of the key (`byok_usage`) before and after all its runs, and writes the change and the Claude Code total to `byok.jsonl`. The counter lags by up to a minute, so it checks the total, not each run.

## Tiers

`--tier smoke|dev|holdout|release` takes the tasks of the splits of the tier in `tiers.json`, with its arms, models, trials and spend cap (plan §5.1). `--tasks` narrows the set to tasks of the tier. `--cap-usd` can lower the cap of the tier, never raise it. A tier can also set the cap of each run in the model gateway (`runCapUsd`) and the reserve of each CTX run (`serverReserveUsd`). A run with no tier takes the dev tasks, the arms `b1plus,ctx,oracle`, Haiku and a cap of $2. `run.py --tier <tier>` is the entry command of a campaign; the factory does not wrap it yet.

| Tier | Tasks | Use |
| --- | --- | --- |
| `smoke` | A fixed subset of about 20 dev tasks, CTX with Haiku only, 1 trial, cap $3 | A breakage check of the tool surface (see [The smoke check](#the-smoke-check)) |
| `dev` | The dev split | Find large wins; read the failure classes |
| `holdout` | The holdout split; the report gives aggregates only | The non-inferiority guard |
| `release` | Each split, also `sealed`; aggregates only | Claims and publication |

The smoke list is `tasks` of the tier `smoke`. While it is `null`, the smoke tier takes the first 20 dev tasks by id: a placeholder until the first baseline exists. Then `python evals/bench/tiers.py pick-smoke <baseline run folder>` prints the dev tasks whose CTX score is in the 30–70% band, nearest to 50% first, for the list. The tier sizes come from the variance of the first baseline (plan §5.1).

A tier with `aggregateOnly` (holdout, release) gives no result of a task: `report.json` has no task list, no runs table, and no per-task delta or stratum, and `run.py` prints no score of a run (plan §5.5).

## Candidate and kept

Production cannot serve unmerged code (D4), so a candidate runs on a local stack that a person or an agent builds from the branch (plan §5.4):

1. Start the stack of the branch on the host (`pnpm dev`), with a backend that exports its spans to the shared collector ([USING.md](../../../../ops/observability/USING.md#localhost-telemetry)), so that the recorder finds them under `DeploymentEnvironment` `local-<name>`.
2. Hydrate the frozen context repo of the twin into the bench org of that stack (`evals/knowledge` hydrate makes the eval org), with the knowledge plane on (D5). A change to ingest, Jev or embeddings needs a new ingest of the snapshot.
3. Make an org key on that stack with `mint-key.ts`, and give it as `CTXPIPE_CANDIDATE_API_KEY`.
4. Run the batch:

```sh
… CTXPIPE_API_KEY=<bench key> CTXPIPE_CANDIDATE_API_KEY=<local key> .venv/bin/python evals/bench/run.py \
  --tier dev --out ~/.cache/ctxpipe-bench/runs/RUN \
  --candidate-mcp-url http://host.docker.internal:3660/mcp --candidate-telemetry-env local-<name> \
  [--mcp-url <kept MCP, default production>] [--sentinel 15]
```

- The arm `ctx` becomes two arms on the same tasks in the same batch: `ctx:kept` (the MCP of `--mcp-url`) and `ctx:candidate`. They change places on each other task, so that neither always runs first. The MCP proxy of a candidate run reaches the host through `host.docker.internal`; the agent still reaches only the proxy.
- The baseline arms come from the cache only: a baseline run that is not in the cache is skipped. The exception is the **B1+ sentinel**: on the first `--sentinel` tasks (default 15, `tiers.json`), B1+ runs again and refreshes its cache record. The report compares each fresh sentinel run with the cached record that it replaced. When the mean drift is above `maxDrift`, the report says so: then run the baselines again with `--no-cache`.

## The keep rule

The report of a candidate batch has the keep rule of ADR-075 decision 9 for `ctx:candidate` against `ctx:kept`, over the tasks that both ran:

- **A win:** an L0 win, or an L2-process win. The L0 eval is `evals/knowledge` on its holdout split; give `analyze.py RUN --l0-win` when it kept the change. An L2-process win is a lower argument error rate (argument errors for each MCP call) or a higher tool adoption (runs with an MCP call), where the 95% bootstrap interval of the gain over the tasks lies above 0.
- **Non-inferiority:** for the score, the cost ($ of a run) and the harm (the score on the tasks of the `harmFamilies`, T12), the 95% bootstrap interval of the per-task delta must exclude a loss larger than its margin (`tiers.json`: 0.05 of score, 20% of the kept cost, 0.05 of harm score). The margins are fixed before the run.
- **The verdict:** `keep` when it wins and each guard is non-inferior; `reject` when an interval shows a loss larger than its margin; else `inconclusive`, which does not keep the change. Fewer paired tasks than `minTasks` (10) are inconclusive. The report gives the delta, the interval and the margin of each guard, and the gain and the interval of each process metric.

## The smoke check

The smoke tier is also a check of the check manifest: `eval:bench:apps/backend/evals/bench/tiers.json#smoke` ([`scripts/checks/evals.mjs`](../../../../scripts/checks/evals.mjs)). `factory check` selects it only when a file of the MCP tool surface changes: each tool with its name, description and input schema (`src/mcp/tools.ts`, `src/mcp/tools/`), the tool registry and framework (`src/mcp/framework/`), and the agent guidance (`plugins/ctxpipe/skills/`), without tests. No other change selects it, and no model step adds or drops it (`selectBy: "inputs"` in the manifest).

The check makes no model call. Under `factory check`, no check gets the model key. The paid run is the smoke tier on the host, against a local stack of the branch:

```sh
… CTXPIPE_API_KEY=<local key> .venv/bin/python evals/bench/run.py --tier smoke \
  --out ~/.cache/ctxpipe-bench/runs/smoke-<date> \
  --mcp-url http://host.docker.internal:3660/mcp --telemetry-env local-<name>
```

- It runs the CTX arm with Haiku on the smoke list, 1 trial, with a cap of $0.15 for each run in the model gateway and $3 for the invocation. The gateway reserves the worst cost of each request (above 100,000 bytes of body, at the long-context price), so a run needs a cap of about $0.15.
- It writes one verdict for each hash of the tool surface to `~/.cache/ctxpipe-bench/smoke/<hash>.json`. The hash is over the path and the bytes of each file of the surface (`node scripts/checks/evals.mjs surface`, tracked and new files). When the verdict of the surface is there, the smoke tier makes no run and costs $0 (`--no-cache` runs it again). A run that the cap stopped, or that has an infrastructure error, writes no verdict.
- Only the smoke list of `tiers.json` in `tasks/<twin>` gives the verdict that the check reads. A run of other tasks (`--tasks`, `--tasks-dir`) keeps its verdict under `<hash>-<hash of the tasks>.json`.
- The `--out` folder of a smoke run holds the runs of one tool surface: a folder of another surface is refused.
- Production serves the tools of `main`. Thus the smoke tier refuses the production MCP when the surface of the checkout is not the surface of `origin/main`: give the MCP of a local stack of the checkout. The smoke tier cannot see which tools a local stack serves; the person or agent that starts it from the checkout states it.
- The verdict is a breakage check, not a measure: it fails on an invalid run (D5), an infrastructure error, an own-service error, an argument error rate above 0.5, more than half of the tasks with no MCP call, more than half of the runs stopped at a limit, or a score more than 0.4 below `referenceScore` (set from the first baseline; `null` until then).
- The check reads the verdict of the tool surface of the checkout: it passes or fails as the verdict does. Without a verdict, its prerequisite `bench-smoke` fails with the fix. It is stochastic, so it has no key and `factory check` stores no pass; it reads the verdict again at no cost. No job of PR CI runs it: the merge gate lists it as `not run by PR CI`.

## The record of a run

`runs.jsonl` holds one record for each run: the score (and `rawScore`, the score of the grader before an own-service error), the matched facts, the tokens (input, output, cache read, cache write), the Claude Code cost, the gateway total, the turns, the agent time and the wall time, the tool calls of the transcript, the MCP error results (`mcpErrors`: the tool error code, or `schema` for bad arguments that the MCP SDK refused), the argument errors, the own-service errors, the gold files that the run saw, the snapshot that a CTX run read (`served`: the `branch@sha` of each hit and file in the MCP results, for example `main@<sha>` for the Workspace and `<sha>@<sha>` for a pinned repository), the proxy counts, the server spans (calls and error codes for each tool, ClickHouse spans, Jev calls, model cost), the D5 proof (`valid`, `invalidReasons`), and the error class (`infra`, `own-service` or none). The trial folder of each run holds the full transcript (`agent/claude-code.txt`, `agent/trajectory.json`) and the verifier output.

## The report

`analyze.py` writes `report.json` and `report.md`. For each model and corpus size, it gives:

- for each arm: the mean continuous score, pass@1 (the first trial of each task), pass^k (each of the first k trials passes; k is the smallest count of trials of a task), $/task (the mean cost of one run), $/success, the mean tokens, the wall time and the turns;
- the paired delta of each arm against B1+: the mean over the tasks of the difference of the mean trial scores, with a 95% bootstrap interval over the tasks, and the strata by `family`, `lexical_hook` and repository count;
- the process of the CTX arm: the MCP calls and their share of the tool calls, the tasks with no MCP call, the argument errors and their rate, the runs with an own-service error, the server tools, the Jev calls, the D5 counts, and the served snapshots (two SHAs of the Workspace branch mean that the snapshot changed during the runs);
- for a candidate batch: the keep rule and its numbers (see [The keep rule](#the-keep-rule)), and the drift of the B1+ sentinel;
- the failure class of each failed run: own-service error, infra (an infrastructure error that did not run again), tool not used (a CTX run with no MCP call), reasoning with gold seen (the run saw a gold file, or the arm is ORACLE), bad args (an argument error and no gold file seen), or retrieval miss.
