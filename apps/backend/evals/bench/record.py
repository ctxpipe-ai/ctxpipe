"""The recorder of the OrgBench spike (CTX-1660): one record for each run.

A record holds the reward, the tokens, the cost, the wall time, the turns and
the MCP tool calls of the transcript, and the MCP server spans of the run,
joined by `x-ctxpipe-conversation-id` (the span attribute
`ctxpipe.mcp.conversation.id`). It also holds the proof of decision D5 of the
plan: the FalkorDB graph commands during the run (the `INFO commandstats` of
the FalkorDB of the backend), the `falkordb` spans in the traces of the run,
and the `knowledge_plane.fallback` logs.

  python record.py RUN_FOLDER   writes report.md from RUN_FOLDER/runs.jsonl
"""

import collections
import json
import os
import subprocess
import sys
import time
import urllib.request
from pathlib import Path


def falkor_graph_calls(container):
    """The count of GRAPH.* commands that the FalkorDB server answered."""
    out = subprocess.run(
        ["docker", "exec", container, "redis-cli", "INFO", "commandstats"],
        capture_output=True, text=True, check=True,
    ).stdout
    calls = 0
    for line in out.splitlines():
        if line.lower().startswith("cmdstat_graph."):
            calls += int(line.split("calls=")[1].split(",")[0])
    return calls


def openrouter_key():
    """The status of the OpenRouter model key of the run, or None for another endpoint."""
    base = os.environ.get("ANTHROPIC_BASE_URL", "")
    token = os.environ.get("ANTHROPIC_AUTH_TOKEN") or os.environ.get("ANTHROPIC_API_KEY")
    if "openrouter.ai" not in base or not token:
        return None
    request = urllib.request.Request(
        "https://openrouter.ai/api/v1/key", headers={"Authorization": f"Bearer {token}"}
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.load(response)["data"]


def key_limit_problem():
    """Why the OpenRouter key cannot cap the spend of the Claude calls, or None.

    The Claude calls of OpenRouter go to the provider key of the account
    (BYOK), so the limit of the key caps them only when it counts that usage.
    """
    key = openrouter_key()
    if key is None:
        return None
    if key.get("limit") is None:
        return "the OpenRouter key has no spend limit"
    if not key.get("include_byok_in_limit"):
        return "the limit of the OpenRouter key does not count the provider-key (BYOK) usage of the Claude calls"
    return None


def gateway_usage():
    """The upstream spend of the OpenRouter key on the provider key of the account (`byok_usage`).

    The counter lags by up to a minute, so the function reads until two reads
    20 s apart agree.
    """
    if openrouter_key() is None:
        return None
    last = openrouter_key()["byok_usage"]
    for _ in range(6):
        time.sleep(20)
        now = openrouter_key()["byok_usage"]
        if now == last:
            break
        last = now
    return last


def transcript(stream_path):
    """The result event, the tool calls and the failed MCP calls of a Claude Code transcript.

    A call with bad arguments fails in the MCP SDK before the tool runs, so it
    has no `mcp.tool` span: only the transcript shows it.
    """
    result, tools, names, failed = {}, collections.Counter(), {}, collections.Counter()
    if not stream_path.is_file():
        return result, tools, failed
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
            name = names.get(block.get("tool_use_id"), "")
            if block.get("type") == "tool_result" and block.get("is_error") and name.startswith("mcp__"):
                failed[name] += 1
    return result, tools, failed


def attributes(item):
    return {a["key"]: next(iter(a["value"].values()), None) for a in item.get("attributes", [])}


def server_spans(otlp_path, conversation_id, started):
    """The MCP server spans of one conversation and the spans of their traces."""
    spans, fallback_logs = [], 0
    since = int(started * 1e9)
    if otlp_path.is_file():
        for line in otlp_path.read_text().splitlines():
            batch = json.loads(line)
            for resource in batch.get("resourceSpans", []):
                for scope in resource["scopeSpans"]:
                    spans += [(s, attributes(s)) for s in scope["spans"]]
            for resource in batch.get("resourceLogs", []):
                for scope in resource["scopeLogs"]:
                    for log in scope["logRecords"]:
                        if int(log.get("timeUnixNano", 0)) >= since and "knowledge_plane.fallback" in json.dumps(log):
                            fallback_logs += 1
    # Child spans carry the attribution of the call too, so only the
    # `mcp.tool` span counts as the call.
    tool_spans = [
        (s, a) for s, a in spans
        if s["name"].startswith("mcp.tool") and a.get("ctxpipe.mcp.conversation.id") == conversation_id
    ]
    traces = {s["traceId"] for s, _ in tool_spans}
    in_traces = [(s, a) for s, a in spans if s["traceId"] in traces]
    return {
        "tools": dict(collections.Counter(a.get("ctxpipe.mcp.tool") for _, a in tool_spans)),
        "errors": dict(collections.Counter(
            a["ctxpipe.mcp.error.code"] for _, a in tool_spans if a.get("ctxpipe.mcp.error.code")
        )),
        "jevCalls": sum(s["name"] == "jev.decide" for s, _ in in_traces),
        "modelCostUsd": round(sum(float(a.get("gen_ai.usage.cost", 0)) for _, a in in_traces), 6),
        "falkorSpans": sum(a.get("db.system.name") == "falkordb" for _, a in in_traces),
        "planeFallbackLogs": fallback_logs,
    }


def record_run(*, out, run_id, model, arm, task, cap_usd, otlp, started, ended, falkor_commands):
    trials = sorted((out / "jobs" / run_id).glob("*/agent"))
    trial = trials[0].parent if trials else out / "jobs" / run_id
    result, tools, failed = transcript(trial / "agent" / "claude-code.txt")
    usage = result.get("usage", {})
    tokens = {
        "input": usage.get("input_tokens", 0),
        "output": usage.get("output_tokens", 0),
        "cacheRead": usage.get("cache_read_input_tokens", 0),
        "cacheWrite": usage.get("cache_creation_input_tokens", 0),
    }
    reward_path = trial / "verifier" / "reward.txt"
    facts_path = trial / "verifier" / "facts.json"
    trial_result = json.loads((trial / "result.json").read_text()) if (trial / "result.json").is_file() else {}
    return {
        "runId": run_id,
        "model": model,
        "arm": arm,
        "task": task,
        "reward": float(reward_path.read_text()) if reward_path.is_file() else None,
        "facts": json.loads(facts_path.read_text())["facts"] if facts_path.is_file() else None,
        "tokens": tokens,
        "claudeCodeCostUsd": result.get("total_cost_usd"),
        "runCapUsd": cap_usd,
        "turns": result.get("num_turns"),
        "agentSeconds": round(result.get("duration_ms", 0) / 1000, 1),
        "wallSeconds": round(ended - started, 1),
        "stopReason": result.get("subtype"),
        "toolCalls": dict(tools),
        "mcpCalls": sum(n for name, n in tools.items() if name.startswith("mcp__")),
        "mcpFailedCalls": dict(failed),
        "server": server_spans(otlp, run_id, started),
        "falkorGraphCommands": falkor_commands,
        "error": (trial_result.get("exception_info") or {}).get("exception_type")
        or (None if result else "no result event")
        or (None if reward_path.is_file() else "no reward"),
        "trial": str(trial),
    }


def run_cost(run):
    """The spend of a run: the agent, and the model calls of the server.

    A run with no result event (a timeout, a crash) has no cost count, so it
    counts as its full cap.
    """
    agent = run["claudeCodeCostUsd"]
    return (run["runCapUsd"] if agent is None else agent) + run["server"]["modelCostUsd"]


def write_report(out, runs):
    lines = [
        "| Model | Arm | Task | Score | $ Claude Code | $ server | Input | Output | Cache read | Cache write | Turns | Agent s | Wall s | MCP calls | Falkor cmds | Error |",
        "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ]
    for r in runs:
        t = r["tokens"]
        cost = "-" if r["claudeCodeCostUsd"] is None else f"{r['claudeCodeCostUsd']:.4f}"
        lines.append(
            f"| {r['model']} | {r['arm']} | {r['task']} | {r['reward']} | "
            f"{cost} | {r['server']['modelCostUsd']:.4f} | "
            f"{t['input']} | {t['output']} | {t['cacheRead']} | {t['cacheWrite']} | {r['turns']} | "
            f"{r['agentSeconds']} | {r['wallSeconds']} | {r['mcpCalls']} | {r['falkorGraphCommands']} | {r['error'] or ''} |"
        )
    lines.append("")
    lines.append(f"Total spend: ${sum(run_cost(r) for r in runs):.4f}")
    (out / "report.md").write_text("\n".join(lines) + "\n")
    print("\n".join(lines))


if __name__ == "__main__":
    folder = Path(sys.argv[1])
    write_report(folder, [json.loads(line) for line in (folder / "runs.jsonl").read_text().splitlines()])
