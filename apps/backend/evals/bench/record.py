"""The recorder of OrgBench (phase 1, CTX-1664): one record for each run.

A record holds the score, the tokens, the cost, the wall time, the turns and
the tool calls of the transcript, the MCP proxy counts, and the MCP server
spans of the run. The recorder reads the spans from HyperDX, joined by the
conversation id that the MCP proxy sends (`x-ctxpipe-conversation-id`, the
span attribute `ctxpipe.mcp.conversation.id`). A CTX run is valid only with
the proof of decision D5: no `knowledge_plane.fallback` log of the bench org during the run, and a span
for each tool call that the proxy forwarded. `analyze.py` reads the records.
"""

import collections
import json
import os
import re
import time
import tomllib
import urllib.request
from datetime import datetime, timezone

# The provenance of a hit or a file of the MCP tools: `served: {branch, sha}`
# as JSON, or the same keys as indented text.
SERVED = re.compile(r'served"?\s*:\s*\{?\s*"?branch"?\s*:\s*"?([^\s",}]+)"?\s*,?\s*"?sha"?\s*:\s*"?([0-9a-f]{40})')

# The MCP tool error codes (apps/backend/src/mcp/framework/tool-errors.ts)
# that are errors of the arm's own service, not of the agent (ADR-075 decision 7).
OWN_SERVICE_CODES = {"internal", "too_many_requests", "judge_unavailable", "workspace_not_ready"}


def openrouter_key_status():
    """The status of the OpenRouter model key of the run, or None for another endpoint."""
    base = os.environ.get("ANTHROPIC_BASE_URL", "")
    token = os.environ.get("ANTHROPIC_AUTH_TOKEN")
    if "openrouter.ai" not in base or not token:
        return None
    request = urllib.request.Request(
        "https://openrouter.ai/api/v1/key", headers={"Authorization": f"Bearer {token}"}
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.load(response)["data"]


def byok_usage():
    """The upstream spend of the OpenRouter key on the provider key of the account (`byok_usage`).

    The counter lags by up to a minute, so the function reads until two reads
    20 s apart agree.
    """
    status = openrouter_key_status()
    if status is None:
        return None
    last = status["byok_usage"]
    for _ in range(6):
        time.sleep(20)
        now = openrouter_key_status()["byok_usage"]
        if now == last:
            break
        last = now
    return last


def hyperdx(tool, arguments):
    """Call a tool of the HyperDX MCP (ops/observability/USING.md, Agent hosts)."""
    headers = {
        "Authorization": f"Bearer {os.environ['HYPERDX_ACCESS_KEY']}",
        "CF-Access-Client-Id": os.environ["HYPERDX_CF_ACCESS_CLIENT_ID"],
        "CF-Access-Client-Secret": os.environ["HYPERDX_CF_ACCESS_CLIENT_SECRET"],
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
        # Cloudflare refuses the default Python user agent.
        "User-Agent": "orgbench-recorder/1",
    }
    body = {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": tool, "arguments": arguments}}
    request = urllib.request.Request("https://hyperdx.ctxpipe.dev/api/mcp", json.dumps(body).encode(), headers)
    with urllib.request.urlopen(request, timeout=120) as response:
        text = response.read().decode()
    data = mcp_reply(text)
    content = data["result"]["content"][0]["text"]
    if data["result"].get("isError"):
        raise RuntimeError(content)
    return json.loads(content)


def hyperdx_sql(sql, started, ended):
    connection = hyperdx("clickstack_list_sources", {})["connections"][0]["id"]
    iso = lambda t: datetime.fromtimestamp(t, timezone.utc).isoformat()
    result = hyperdx("clickstack_sql", {"connectionId": connection, "sql": sql, "startTime": iso(started), "endTime": iso(ended)})
    return result["result"]["data"]


def server_spans(conversation_id, *, env, org_slug, started, ended, expected_calls):
    """The MCP server spans of one run and the D5 proof, from HyperDX.

    The backend exports spans in batches, so the recorder reads again until
    the spans of each forwarded tool call are there, for at most five minutes.
    """
    # The ids are ours (run.py, arms.json); check them anyway, because they go into SQL.
    for value in (conversation_id, env, org_slug):
        if not re.fullmatch(r"[A-Za-z0-9._-]+", value):
            raise ValueError(f"unsafe value for SQL: {value!r}")
    traces = (
        "SELECT DISTINCT TraceId FROM otel.otel_traces WHERE $__timeFilter(Timestamp)"
        f" AND DeploymentEnvironment = '{env}' AND SpanName LIKE 'mcp.tool%'"
        f" AND SpanAttributes['ctxpipe.mcp.conversation.id'] = '{conversation_id}'"
    )
    spans_sql = (
        "SELECT countIf(SpanName LIKE 'mcp.tool%') AS toolSpans,"
        " groupArrayIf(SpanAttributes['ctxpipe.mcp.tool'], SpanName LIKE 'mcp.tool%') AS tools,"
        " groupArrayIf(SpanAttributes['ctxpipe.mcp.error.code'], SpanName LIKE 'mcp.tool%' AND SpanAttributes['ctxpipe.mcp.error.code'] != '') AS errors,"
        " countIf(SpanName = 'jev.decide') AS jevCalls,"
        " countIf(SpanAttributes['db.system.name'] = 'clickhouse') AS clickhouseSpans,"
        " sum(toFloat64OrZero(SpanAttributes['gen_ai.usage.cost'])) AS modelCostUsd"
        f" FROM otel.otel_traces WHERE $__timeFilter(Timestamp) AND DeploymentEnvironment = '{env}' AND TraceId IN ({traces})"
    )
    # Each fallback of the bench org during the run counts, also one with no trace of the run.
    logs_sql = (
        "SELECT count() AS fallbackLogs FROM otel.otel_logs WHERE $__timeFilter(Timestamp)"
        f" AND DeploymentEnvironment = '{env}' AND LogAttributes['step'] = 'knowledge_plane.fallback'"
        f" AND (LogAttributes['ctxpipe.org.slug'] = '{org_slug}' OR TraceId IN ({traces}))"
    )
    deadline = time.time() + 300
    try:
        while True:
            spans = hyperdx_sql(spans_sql, started - 60, max(time.time(), ended) + 60)[0]
            if int(spans["toolSpans"]) >= expected_calls or time.time() > deadline:
                break
            time.sleep(20)
        logs = hyperdx_sql(logs_sql, started, ended)[0]
    except (OSError, RuntimeError, KeyError, ValueError) as error:
        return {"error": f"HyperDX: {error}"}
    return {
        "toolSpans": int(spans["toolSpans"]),
        "tools": dict(collections.Counter(spans["tools"])),
        "errors": dict(collections.Counter(spans["errors"])),
        "jevCalls": int(spans["jevCalls"]),
        "clickhouseSpans": int(spans["clickhouseSpans"]),
        "planeFallbackLogs": int(logs["fallbackLogs"]),
        "modelCostUsd": round(float(spans["modelCostUsd"]), 6),
    }


def result_text(block):
    content = block.get("content")
    return content if isinstance(content, str) else " ".join(c.get("text", "") for c in content or [] if isinstance(c, dict))


def result_code(block):
    """The error code of an MCP error result: the code of a tool error, or `schema` for bad arguments."""
    text = result_text(block)
    # The MCP SDK refuses bad arguments before the tool runs: no span, only this text.
    if "-32602" in text or "Invalid arguments" in text:
        return "schema"
    # A tool error, as JSON or as indented text (`code: unknown_ref`).
    match = re.search(r'"?\bcode"?\s*:\s*"?([a-z_]+)', text)
    return match.group(1) if match else "other"


def transcript(stream_path):
    """The result event, the tool calls, the MCP error codes, the served snapshots and the tool text of a Claude Code transcript."""
    result, tools, names, errors, text, served = {}, collections.Counter(), {}, [], [], collections.Counter()
    if not stream_path.is_file():
        return result, tools, errors, served, ""
    for line in stream_path.read_text(errors="replace").splitlines():
        if not line.startswith("{"):
            continue
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if event.get("type") == "result":
            result = event
        content = event.get("message", {}).get("content", [])
        for block in content if isinstance(content, list) else []:
            if block.get("type") == "tool_use":
                tools[block["name"]] += 1
                names[block["id"]] = block["name"]
                text.append(json.dumps(block.get("input")))
            if block.get("type") == "tool_result":
                text.append(json.dumps(block.get("content")))
                if names.get(block.get("tool_use_id"), "").startswith("mcp__"):
                    if block.get("is_error"):
                        errors.append(result_code(block))
                    served.update(f"{branch}@{sha}" for branch, sha in SERVED.findall(result_text(block)))
    return result, tools, errors, served, "\n".join(text)


def task_config(task_dir):
    """The task.toml of a task; run.py and analyze.py read its `[metadata]` (README.md)."""
    path = task_dir / "task.toml"
    return tomllib.loads(path.read_text()) if path.is_file() else {}


def run_key(run):
    """The identity of a run in a run folder: a new attempt of the same key replaces the record."""
    return (run["model"], run["arm"], run["task"], run["trial"], run["repos"])


def mcp_reply(text):
    """The JSON-RPC message of an MCP reply: server-sent events or plain JSON."""
    return json.loads(next(line[5:] for line in text.splitlines() if line.startswith("data:")) if "data:" in text else text)


def workspace_snapshot(mcp_url, key, org, workspace):
    """The `branch@sha` that the Workspace serves now: `list_files` of the root names it (`served`)."""
    headers = {"x-api-key": key, "Content-Type": "application/json", "Accept": "application/json, text/event-stream", "User-Agent": "orgbench-runner/1"}
    body = {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "list_files", "arguments": {"org": org, "workspace": workspace, "path": "", "excludeRepositories": []}}}
    try:
        with urllib.request.urlopen(urllib.request.Request(mcp_url, json.dumps(body).encode(), headers), timeout=60) as response:
            text = response.read().decode()
        data = mcp_reply(text)
        match = SERVED.search(" ".join(c.get("text", "") for c in data["result"]["content"]))
    except (OSError, ValueError, KeyError, StopIteration) as error:
        return f"error: {error}"
    return f"{match.group(1)}@{match.group(2)}" if match else "error: no served field"


def gold_seen(task_dir, tool_text):
    """The gold files that a tool call named or returned (the path, or the path in its repository)."""
    meta = task_config(task_dir).get("metadata", {})
    seen = []
    for ref in meta.get("gold_context", []):
        path = ref.split("#")[0]
        inner = path.split("/", 2)[2] if path.startswith("repos/") else path
        if inner in tool_text:
            seen.append(ref)
    return seen, len(meta.get("gold_context", []))


def read_json(path):
    return json.loads(path.read_text()) if path.is_file() else {}


def record_run(*, out, run_id, model, arm, task, trial, attempt, repos, cap_usd, mcp, started, ended, telemetry_env, org_slug, task_dir, snapshot):
    trials = sorted((out / "jobs" / run_id).glob("*/agent"))
    trial_dir = trials[0].parent if trials else out / "jobs" / run_id
    result, tools, mcp_errors, served, tool_text = transcript(trial_dir / "agent" / "claude-code.txt")
    usage = result.get("usage", {})
    reward_path = trial_dir / "verifier" / "reward.txt"
    exception = (read_json(trial_dir / "result.json").get("exception_info") or {}).get("exception_type")
    gateway = read_json(out / "gateway" / run_id / "spend.json")
    proxy = read_json(out / "mcp" / run_id / "calls.json") if mcp else {}
    # Each tool call that the server answered has a span, except a call with
    # bad arguments: the MCP SDK refuses it before the tool runs.
    expected_spans = proxy.get("toolCallsAnswered", 0) - mcp_errors.count("schema")
    server = {}
    if mcp:
        server = server_spans(run_id, env=telemetry_env, org_slug=org_slug, started=started, ended=ended, expected_calls=expected_spans)
    statuses = proxy.get("statuses", {})
    own_service = (
        sum(n for code, n in statuses.items() if code == "429" or code.startswith("5"))
        + proxy.get("timeouts", 0) + proxy.get("connectionErrors", 0)
        + sum(code in OWN_SERVICE_CODES for code in mcp_errors)
    )
    error = exception or (None if result else "no result event") or (None if reward_path.is_file() else "no reward")
    # The arm's own service errors count as failures; model API errors and
    # harness crashes are infrastructure and run again (ADR-075 decision 7).
    # An agent that stops at its turn, dollar or time limit fails the task
    # (Claude Code then exits with an error, and Harbor can raise).
    limit = (
        str(result.get("subtype", "")).startswith("error_max")
        or gateway.get("refused")
        or exception == "AgentTimeoutError"
    )
    if own_service:
        error_class = "own-service"
    elif limit:
        error_class = None
    elif error or (result.get("is_error") and "API Error" in str(result.get("result"))):
        error_class = "infra"
    else:
        error_class = None
    raw = float(reward_path.read_text()) if reward_path.is_file() else None
    invalid = []
    if mcp:
        if "error" in server:
            invalid.append(server["error"])
        else:
            if server["planeFallbackLogs"]:
                invalid.append(f"{server['planeFallbackLogs']} knowledge_plane.fallback logs")
            if server["toolSpans"] < expected_spans:
                invalid.append(f"{server['toolSpans']} tool spans for {expected_spans} answered calls with valid arguments")
    seen, gold_count = gold_seen(task_dir, tool_text)
    return {
        "runId": run_id,
        "model": model,
        "arm": arm,
        "task": task,
        "trial": trial,
        "attempt": attempt,
        "repos": repos,
        # An own-service error fails the run whatever the grader says, and a
        # run with no reward that is not infrastructure fails the task.
        "score": 0.0 if error_class == "own-service" or (raw is None and error_class is None) else raw,
        "rawScore": raw,
        "facts": read_json(trial_dir / "verifier" / "facts.json").get("facts"),
        "tokens": {
            "input": usage.get("input_tokens", 0),
            "output": usage.get("output_tokens", 0),
            "cacheRead": usage.get("cache_read_input_tokens", 0),
            "cacheWrite": usage.get("cache_creation_input_tokens", 0),
        },
        "claudeCodeCostUsd": result.get("total_cost_usd"),
        "gatewayCostUsd": gateway.get("usd"),
        "gatewayRequests": gateway.get("requests"),
        "gatewayRefused": gateway.get("refused"),
        "runCapUsd": cap_usd,
        "turns": result.get("num_turns"),
        "agentSeconds": round(result.get("duration_ms", 0) / 1000, 1),
        "wallSeconds": round(ended - started, 1),
        "stopReason": result.get("subtype"),
        "toolCalls": dict(tools),
        "mcpCalls": sum(n for name, n in tools.items() if name.startswith("mcp__")),
        "mcpErrors": dict(collections.Counter(mcp_errors)),
        "argErrors": sum(code not in OWN_SERVICE_CODES and code != "other" for code in mcp_errors),
        "ownServiceErrors": own_service,
        "goldSeen": seen,
        "goldCount": gold_count,
        # The snapshot that the CTX arm read: `branch@sha` of each served hit
        # or file (the Workspace branch, or the pinned commit of a repository).
        "served": dict(served),
        # The Workspace snapshot before and after the run (`list_files`), also
        # for a run whose results name no snapshot.
        "snapshot": snapshot,
        "proxy": proxy,
        "server": server,
        "valid": not invalid,
        "invalidReasons": invalid,
        "error": error,
        "errorClass": error_class,
        "trialDir": str(trial_dir),
    }


def run_cost(run):
    """The spend of a run: the agent, and the model calls of the server.

    The agent spend is the total of the model gateway, which also counts the
    model requests that did not come from Claude Code. A run with no gateway
    total uses the Claude Code cost, and a run with neither counts as its full cap.
    """
    agent = run.get("gatewayCostUsd")
    if agent is None:
        agent = run["claudeCodeCostUsd"]
    return (run["runCapUsd"] if agent is None else agent) + run["server"].get("modelCostUsd", 0)
